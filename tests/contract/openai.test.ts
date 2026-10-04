import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { edge, faults } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM({ seed: 7 });
const client = (opts: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}) =>
  new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0, ...opts });
const ask = (content: string, extra: Partial<OpenAI.ChatCompletionCreateParamsNonStreaming> = {}) =>
  client().chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content }], ...extra });

const weatherTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
};

describe('openai: chat completions', () => {
  it('returns a scripted text reply with realistic shape', async () => {
    mock.when(/refund/i).reply('Refunds take 5 days.');
    const r = await ask('How do refunds work?');
    expect(r.object).toBe('chat.completion');
    expect(r.choices[0]!.message.content).toBe('Refunds take 5 days.');
    expect(r.choices[0]!.finish_reason).toBe('stop');
    expect(r.usage!.total_tokens).toBe(r.usage!.prompt_tokens + r.usage!.completion_tokens);
    expect(r.id).toMatch(/^chatcmpl-/);
  });

  it('falls back to a default reply when nothing matches', async () => {
    const r = await ask('anything');
    expect(r.choices[0]!.message.content).toContain('mock');
  });

  it('streams text deltas and a usage chunk', async () => {
    mock.when({}).reply('one two three four');
    const stream = await client().chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let usage: OpenAI.CompletionUsage | undefined | null;
    let finish: string | null = null;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      finish = chunk.choices[0]?.finish_reason ?? finish;
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toBe('one two three four');
    expect(finish).toBe('stop');
    expect(usage?.completion_tokens).toBeGreaterThan(0);
  });

  it('drives a tool-call agent loop with a sequence', async () => {
    mock
      .when({ hasTools: true })
      .replyToolCall('get_weather', { city: 'Paris' })
      .then.replyTemplate('It is sunny in Paris ({{model}}).');

    const c = client();
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Weather in Paris?' }];
    const first = await c.chat.completions.create({ model: 'gpt-4o', messages, tools: [weatherTool] });
    const call = first.choices[0]!.message.tool_calls![0]! as OpenAI.ChatCompletionMessageFunctionToolCall;
    expect(first.choices[0]!.finish_reason).toBe('tool_calls');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' });

    messages.push(first.choices[0]!.message, { role: 'tool', tool_call_id: call.id, content: '{"temp": 21}' });
    const second = await c.chat.completions.create({ model: 'gpt-4o', messages, tools: [weatherTool] });
    expect(second.choices[0]!.message.content).toBe('It is sunny in Paris (gpt-4o).');

    const sent = mock.journal.last()!.request;
    expect(sent.messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', toolCallId: call.id });
  });

  it('streams tool calls that the SDK helper can reassemble', async () => {
    mock.when({}).replyToolCall('get_weather', { city: 'Oslo', days: 3 });
    const final = await client()
      .chat.completions.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], tools: [weatherTool] })
      .finalChatCompletion();
    const call = final.choices[0]!.message.tool_calls![0]! as OpenAI.ChatCompletionMessageFunctionToolCall;
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Oslo', days: 3 });
  });

  it('records what the app sent', async () => {
    await ask('hello', { messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'hello' }] });
    expect(mock.journal.last()!.request.system).toBe('You are terse.');
    expect(mock.journal.count({ provider: 'openai' })).toBe(1);
  });
});

describe('openai: edge cases', () => {
  it('refusal sets message.refusal', async () => {
    mock.when({}).reply(edge.refusal('No.'));
    const r = await ask('x');
    expect(r.choices[0]!.message.refusal).toBe('No.');
    expect(r.choices[0]!.message.content).toBeNull();
  });

  it('truncation reports finish_reason=length', async () => {
    mock.when({}).reply(edge.truncated('{"a": [1, 2, 3]}'));
    const r = await ask('x');
    expect(r.choices[0]!.finish_reason).toBe('length');
    expect(() => JSON.parse(r.choices[0]!.message.content!)).toThrow();
  });

  it('malformed tool arguments are passed through verbatim', async () => {
    mock.when({}).reply(edge.malformedToolArgs('get_weather'));
    const r = await ask('x', { tools: [weatherTool] });
    const call = r.choices[0]!.message.tool_calls![0]! as OpenAI.ChatCompletionMessageFunctionToolCall;
    expect(() => JSON.parse(call.function.arguments)).toThrow();
  });

  it('inject() adds caller-supplied text to replies', async () => {
    mock.when({}).reply('Your order shipped.').inject(' <b>UNESCAPED</b>');
    expect((await ask('x')).choices[0]!.message.content).toBe('Your order shipped. <b>UNESCAPED</b>');
  });

  it('per-request scenario via header and magic token', async () => {
    const viaHeader = client({ defaultHeaders: { 'x-mock-scenario': 'unicode' } });
    const r = await viaHeader.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    expect(r.choices[0]!.message.content).toContain('👩🏽‍💻');
    await expect(ask('please [[mock:context-length]]')).rejects.toMatchObject({ status: 400, code: 'context_length_exceeded' });
  });

  it('custom named scenarios', async () => {
    mock.scenario('vip').reply('Welcome back, VIP.');
    expect((await ask('hi [[mock:vip]]')).choices[0]!.message.content).toBe('Welcome back, VIP.');
  });
});

describe('openai: faults', () => {
  it('maps error kinds to the SDK error classes', async () => {
    mock.when('auth').fail(faults.authError());
    mock.when('missing').fail(faults.notFound());
    mock.when('boom').fail(faults.serverError());
    mock.when('busy').fail(faults.rateLimit({ retryAfter: 0 }));
    await expect(ask('auth')).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
    await expect(ask('missing')).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await expect(ask('boom')).rejects.toBeInstanceOf(OpenAI.InternalServerError);
    await expect(ask('busy')).rejects.toBeInstanceOf(OpenAI.RateLimitError);
  });

  it('a one-off 429 is retried by the SDK honoring retry-after', async () => {
    mock.when({}).reply('ok');
    mock.when({}).once().fail(faults.rateLimit({ retryAfter: 0.01 }));
    const r = await client({ maxRetries: 2 }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    expect(r.choices[0]!.message.content).toBe('ok');
    expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]);
  });

  it('timeouts surface as APIConnectionTimeoutError', async () => {
    mock.when({}).fail(faults.timeout());
    await expect(client({ timeout: 200 }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
      OpenAI.APIConnectionTimeoutError,
    );
  });

  it('connection resets surface as APIConnectionError', async () => {
    mock.when({}).fail(faults.connectionReset());
    await expect(ask('x')).rejects.toBeInstanceOf(OpenAI.APIConnectionError);
  });

  it('mid-stream errors and cuts break the stream', async () => {
    const stream = (content: string) =>
      client().chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content }], stream: true });
    const drain = async (s: AsyncIterable<unknown>) => {
      for await (const _ of s);
    };
    mock.when('err').fail(faults.streamError({ afterChunks: 3 }));
    mock.when('cut').fail(faults.streamCut({ afterChunks: 3 }));
    await expect(drain(await stream('err'))).rejects.toBeInstanceOf(OpenAI.APIError);
    await expect(drain(await stream('cut'))).rejects.toThrow();
  });

  it('validates required fields like the real API', async () => {
    await expect(client().chat.completions.create({ model: 'gpt-4o', messages: [] })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });
});

describe('openai: other endpoints', () => {
  it('embeddings are deterministic unit vectors (base64 default decoded by SDK)', async () => {
    const r1 = await client().embeddings.create({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    const r2 = await client().embeddings.create({ model: 'text-embedding-3-small', input: 'a', encoding_format: 'float' });
    expect(r1.data).toHaveLength(2);
    const v = Array.from(r1.data[0]!.embedding);
    expect(v).toHaveLength(1536);
    expect(Math.hypot(...v)).toBeCloseTo(1, 4);
    expect(r2.data[0]!.embedding[5]).toBeCloseTo(v[5]!, 6);
  });

  it('lists models', async () => {
    const ids = [];
    for await (const m of client().models.list()) ids.push(m.id);
    expect(ids).toContain('gpt-4o');
  });
});
