import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  CountTokensCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { faults } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM({ seed: 7 });
const CLAUDE = 'us.anthropic.claude-sonnet-5-5';
const client = () =>
  new BedrockRuntimeClient({ endpoint: mock.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
const decoder = new TextDecoder();

const weatherTool = { toolSpec: { name: 'get_weather', inputSchema: { json: { type: 'object', properties: { city: { type: 'string' } } } } } };

describe('bedrock: Converse', () => {
  it('returns scripted text', async () => {
    mock.when({ provider: 'bedrock', lastUserMessage: 'hello' }).reply('Hi from Bedrock!');
    const r = await client().send(
      new ConverseCommand({ modelId: CLAUDE, system: [{ text: 'Be brief.' }], messages: [{ role: 'user', content: [{ text: 'hello' }] }] }),
    );
    expect(r.output!.message!.content![0]!.text).toBe('Hi from Bedrock!');
    expect(r.stopReason).toBe('end_turn');
    expect(r.usage!.totalTokens).toBe(r.usage!.inputTokens! + r.usage!.outputTokens!);
    expect(mock.journal.last()!.request).toMatchObject({ model: CLAUDE, system: 'Be brief.' });
  });

  it('tool use loop', async () => {
    mock.when({ tool: 'get_weather' }).replyToolCall('get_weather', { city: 'Paris' });
    mock.when({ hasToolResult: true }).reply('Sunny.');
    const messages: Message[] = [{ role: 'user', content: [{ text: 'Weather?' }] }];
    const first = await client().send(new ConverseCommand({ modelId: CLAUDE, messages, toolConfig: { tools: [weatherTool] } }));
    expect(first.stopReason).toBe('tool_use');
    const use = first.output!.message!.content![0]!.toolUse!;
    expect(use).toMatchObject({ name: 'get_weather', input: { city: 'Paris' } });

    messages.push(first.output!.message!, { role: 'user', content: [{ toolResult: { toolUseId: use.toolUseId, content: [{ json: { temp: 21 } }] } }] });
    const second = await client().send(new ConverseCommand({ modelId: CLAUDE, messages, toolConfig: { tools: [weatherTool] } }));
    expect(second.output!.message!.content![0]!.text).toBe('Sunny.');
  });

  it('ConverseStream decodes the binary event stream (text + tool input)', async () => {
    mock.when('text').reply('one two three', { thinking: 'hmm' });
    mock.when('tool').replyToolCall('get_weather', { city: 'Oslo' });
    const r = await client().send(new ConverseStreamCommand({ modelId: CLAUDE, messages: [{ role: 'user', content: [{ text: 'text' }] }] }));
    let text = '';
    let reasoning = '';
    let stop: string | undefined;
    let usage: unknown;
    for await (const ev of r.stream!) {
      text += ev.contentBlockDelta?.delta?.text ?? '';
      reasoning += ev.contentBlockDelta?.delta?.reasoningContent?.text ?? '';
      stop = ev.messageStop?.stopReason ?? stop;
      usage = ev.metadata?.usage ?? usage;
    }
    expect(text).toBe('one two three');
    expect(reasoning).toBe('hmm');
    expect(stop).toBe('end_turn');
    expect(usage).toMatchObject({ outputTokens: expect.any(Number) });

    const t = await client().send(
      new ConverseStreamCommand({ modelId: CLAUDE, messages: [{ role: 'user', content: [{ text: 'tool' }] }], toolConfig: { tools: [weatherTool] } }),
    );
    let input = '';
    let name: string | undefined;
    for await (const ev of t.stream!) {
      name = ev.contentBlockStart?.start?.toolUse?.name ?? name;
      input += ev.contentBlockDelta?.delta?.toolUse?.input ?? '';
    }
    expect(name).toBe('get_weather');
    expect(JSON.parse(input)).toEqual({ city: 'Oslo' });
  });
});

describe('bedrock: InvokeModel (model-native bodies)', () => {
  const invoke = (modelId: string, body: unknown) =>
    client()
      .send(new InvokeModelCommand({ modelId, contentType: 'application/json', body: JSON.stringify(body) }))
      .then((r) => JSON.parse(decoder.decode(r.body)));

  it('Anthropic Claude body', async () => {
    mock.when({}).reply('Claude via Bedrock');
    const r = await invoke(CLAUDE, { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(r).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Claude via Bedrock' }], stop_reason: 'end_turn' });
  });

  it('rejects a Claude body without anthropic_version', async () => {
    await expect(invoke(CLAUDE, { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })).rejects.toBeInstanceOf(ValidationException);
  });

  it('Llama, Nova and Titan embeddings', async () => {
    mock.when('llama').reply('Llama says hi');
    mock.when('nova').reply('Nova says hi');
    const prompt = '<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\nllama?<|eot_id|><|start_header_id|>assistant<|end_header_id|>';
    expect(await invoke('meta.llama3-70b-instruct-v1:0', { prompt, max_gen_len: 50 })).toMatchObject({ generation: 'Llama says hi', stop_reason: 'stop' });
    expect(mock.journal.last()!.request.messages[0]!.content[0]).toEqual({ type: 'text', text: 'llama?' });
    const nova = await invoke('amazon.nova-pro-v1:0', { messages: [{ role: 'user', content: [{ text: 'nova?' }] }] });
    expect(nova.output.message.content[0].text).toBe('Nova says hi');
    const emb = await invoke('amazon.titan-embed-text-v2:0', { inputText: 'hello', dimensions: 256 });
    expect(emb.embedding).toHaveLength(256);
  });

  it('InvokeModelWithResponseStream (Claude chunks)', async () => {
    mock.when({}).reply('streamed claude');
    const r = await client().send(
      new InvokeModelWithResponseStreamCommand({
        modelId: CLAUDE,
        contentType: 'application/json',
        body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      }),
    );
    let text = '';
    let metrics: unknown;
    for await (const ev of r.body!) {
      const e = JSON.parse(decoder.decode(ev.chunk!.bytes));
      if (e.type === 'content_block_delta') text += e.delta.text;
      metrics = e['amazon-bedrock-invocationMetrics'] ?? metrics;
    }
    expect(text).toBe('streamed claude');
    expect(metrics).toMatchObject({ outputTokenCount: expect.any(Number) });
  });
});

describe('bedrock: CountTokens', () => {
  it('counts an InvokeModel body (sent base64-encoded) and a Converse input alike', async () => {
    const messages: Message[] = [{ role: 'user', content: [{ text: 'How many tokens is this sentence?' }] }];
    const invokeBody = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 10, messages: [{ role: 'user', content: 'How many tokens is this sentence?' }] };
    const invoke = await client().send(new CountTokensCommand({ modelId: CLAUDE, input: { invokeModel: { body: new TextEncoder().encode(JSON.stringify(invokeBody)) } } }));
    const converse = await client().send(new CountTokensCommand({ modelId: CLAUDE, input: { converse: { messages } } }));
    expect(invoke.inputTokens).toBeGreaterThan(0);
    expect(invoke.inputTokens).toBe(converse.inputTokens);
    expect(mock.journal.all().map((e) => [e.endpoint, e.status])).toEqual([
      ['count_tokens', 200],
      ['count_tokens', 200],
    ]);
  });

  it('an InvokeModel body that is not JSON → ValidationException', async () => {
    const err = await client()
      .send(new CountTokensCommand({ modelId: CLAUDE, input: { invokeModel: { body: new TextEncoder().encode('not json') } } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationException);
  });
});

describe('bedrock: errors', () => {
  it('maps to AWS exception classes', async () => {
    mock.when('busy').fail(faults.rateLimit());
    mock.when('down').fail(faults.overloaded());
    const send = (text: string) => client().send(new ConverseCommand({ modelId: CLAUDE, messages: [{ role: 'user', content: [{ text }] }] }));
    await expect(send('busy')).rejects.toBeInstanceOf(ThrottlingException);
    await expect(send('down')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('in-stream exception frames raise typed errors', async () => {
    mock.when({}).fail(faults.streamError({ afterChunks: 3, error: { kind: 'rate_limit' } }));
    const r = await client().send(new ConverseStreamCommand({ modelId: CLAUDE, messages: [{ role: 'user', content: [{ text: 'x' }] }] }));
    const drain = async () => {
      for await (const _ of r.stream!);
    };
    await expect(drain()).rejects.toBeInstanceOf(ThrottlingException);
  });
});
