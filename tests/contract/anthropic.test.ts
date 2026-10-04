import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { edge, faults } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM({ seed: 7 });
const MODEL = 'claude-sonnet-5-5';
const client = (opts: Partial<ConstructorParameters<typeof Anthropic>[0]> = {}) =>
  new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'test', maxRetries: 0, ...opts });
const ask = (content: string, extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) =>
  client().messages.create({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content }], ...extra });

const weatherTool: Anthropic.Tool = {
  name: 'get_weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } } },
};

describe('anthropic: messages', () => {
  it('returns a scripted text reply with realistic shape', async () => {
    mock.when({ provider: 'anthropic', lastUserMessage: 'hello' }).reply('Hi there!');
    const r = await ask('hello');
    expect(r.type).toBe('message');
    expect(r.id).toMatch(/^msg_/);
    expect(r.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
    expect(r.stop_reason).toBe('end_turn');
    expect(r.usage.input_tokens).toBeGreaterThan(0);
  });

  it('streams via the SDK MessageStream helper (text + thinking)', async () => {
    mock.when({}).reply('The answer is 42.', { thinking: 'Let me think step by step.' });
    const stream = client().messages.stream({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: 'q' }] });
    const deltas: string[] = [];
    stream.on('text', (t) => deltas.push(t));
    const final = await stream.finalMessage();
    expect(deltas.join('')).toBe('The answer is 42.');
    expect(final.content[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think step by step.' });
    expect(final.content[1]).toMatchObject({ type: 'text', text: 'The answer is 42.' });
    expect(final.usage.output_tokens).toBeGreaterThan(1);
  });

  it('drives a tool_use agent loop (streamed tool input is reassembled)', async () => {
    // Latest matching rule wins, so register the more specific rule last.
    mock.when({ tool: 'get_weather' }).replyToolCall('get_weather', { city: 'Paris' }, { text: 'Checking.' });
    mock.when({ hasToolResult: true }).reply('It is 21°C in Paris.');

    const c = client();
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Weather in Paris?' }];
    const first = await c.messages.stream({ model: MODEL, max_tokens: 1024, messages, tools: [weatherTool] }).finalMessage();
    expect(first.stop_reason).toBe('tool_use');
    const toolUse = first.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock;
    expect(toolUse.input).toEqual({ city: 'Paris' });

    messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '21' }] });
    const second = await c.messages.create({ model: MODEL, max_tokens: 1024, messages, tools: [weatherTool] });
    expect(second.content[0]).toMatchObject({ type: 'text', text: 'It is 21°C in Paris.' });
  });

  it('captures system prompts for assertions', async () => {
    await ask('x', { system: [{ type: 'text', text: 'You are a pirate.' }] });
    expect(mock.journal.last()!.request.system).toBe('You are a pirate.');
  });

  it('accepts mid-conversation system messages (as Claude Code sends)', async () => {
    await client().messages.create({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }, { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    expect(mock.journal.last()!.status).toBe(200);
    expect(mock.journal.last()!.request.system).toBe('Be brief.');
  });

  it('count_tokens and models endpoints', async () => {
    const n = await client().messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'hello world' }] });
    expect(n.input_tokens).toBeGreaterThan(0);
    const ids = [];
    for await (const m of client().models.list()) ids.push(m.id);
    expect(ids).toContain(MODEL);
  });
});

describe('anthropic: edge cases and faults', () => {
  it('refusal stop_reason', async () => {
    mock.when({}).reply(edge.refusal());
    expect((await ask('x')).stop_reason).toBe('refusal');
  });

  it('max_tokens truncation', async () => {
    mock.when({}).reply(edge.truncated('a long answer that gets cut'));
    expect((await ask('x')).stop_reason).toBe('max_tokens');
  });

  it('529 overloaded and native error envelope', async () => {
    mock.when({}).fail(faults.overloaded());
    const err = await ask('x').catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.InternalServerError);
    expect(err.status).toBe(529);
    expect(err.error).toMatchObject({ type: 'error', error: { type: 'overloaded_error' } });
  });

  it('rate limit → RateLimitError; retried once then succeeds', async () => {
    mock.when({}).reply('ok');
    mock.when({}).once().fail(faults.rateLimit({ retryAfter: 0.01 }));
    const r = await client({ maxRetries: 1 }).messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(r.content[0]).toMatchObject({ text: 'ok' });
    expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]);
  });

  it('in-stream error event raises an APIError', async () => {
    mock.when({}).fail(faults.streamError({ afterChunks: 4, error: { kind: 'overloaded' } }));
    const stream = client().messages.stream({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    await expect(stream.finalMessage()).rejects.toBeInstanceOf(Anthropic.APIError);
  });

  it('missing max_tokens is rejected like the real API', async () => {
    await expect(client().messages.create({ model: MODEL, messages: [{ role: 'user', content: 'x' }] } as any)).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
  });

  it('enforces API keys when configured', async () => {
    const strict = await (await import('../../src/index.js')).createMockLLM({ apiKeys: ['good'] });
    try {
      const bad = new Anthropic({ baseURL: strict.urls.anthropic, apiKey: 'bad', maxRetries: 0 });
      await expect(bad.messages.create({ model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
        Anthropic.AuthenticationError,
      );
    } finally {
      await strict.stop();
    }
  });
});
