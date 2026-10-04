import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockLLM, faults, type MockLLM, type MockLLMEventName } from '../../src/index.js';

let mock: MockLLM;
afterEach(async () => {
  vi.restoreAllMocks();
  await mock?.stop();
});

/** Record every event as "<name>" per journal entry id, plus chunk payloads. */
function recorder(m: MockLLM) {
  const log: Array<{ name: MockLLMEventName; id: number; payload: any }> = [];
  for (const name of ['request', 'unmatched', 'chunk', 'response', 'fault'] as const) {
    m.on(name, (p: any) => log.push({ name, id: p.entry.id, payload: p }));
  }
  const sequence = (id: number) => log.filter((e) => e.id === id).map((e) => e.name).join(' ');
  /** Every entry's events follow request → unmatched? → chunk* → exactly one terminal event. */
  const assertOrdering = () => {
    const ids = [...new Set(log.map((e) => e.id))];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(sequence(id)).toMatch(/^request( unmatched)?( chunk)* (response|fault)$/);
  };
  return { log, sequence, assertOrdering };
}

const openai = (m: MockLLM, opts: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}) =>
  new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0, ...opts });
const ask = (m: MockLLM, extra: Record<string, unknown> = {}, opts = {}) =>
  openai(m, opts).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...extra } as any);

describe('event ordering', () => {
  it('non-streaming: request → response, payload is the finished journal entry', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).reply('hello');
    await ask(mock);
    const [req, res] = r.log;
    expect(r.sequence(req!.id)).toBe('request response');
    expect(req!.payload.entry.request.model).toBe('gpt-4o');
    expect(req!.payload.entry.matchedBy).toBe('rule#1');
    expect(res!.payload.entry).toMatchObject({ status: 200, response: { content: [{ type: 'text', text: 'hello' }] } });
    expect(res!.payload.entry.durationMs).toBeGreaterThanOrEqual(0);
    r.assertOrdering();
  });

  it('streaming (SSE): request → chunk × n → response, chunks reassemble the wire body', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).reply('one two three');
    const stream = await ask(mock, { stream: true });
    for await (const _ of stream as any);
    const chunks = r.log.filter((e) => e.name === 'chunk');
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.payload.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.payload.data === c.payload.text)).toBe(true);
    expect(chunks.map((c) => c.payload.text).join('')).toBe(mock.journal.last()!.wire!.response.body);
    expect(chunks.at(-1)!.payload.text).toContain('[DONE]');
    r.assertOrdering();
  });

  it('streaming (Bedrock binary event stream): chunk data is bytes, text is decoded', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).reply('binary frames');
    const client = new BedrockRuntimeClient({ endpoint: mock.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
    const out = await client.send(new ConverseStreamCommand({ modelId: 'anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text: 'x' }] }] }));
    for await (const _ of out.stream!);
    const chunks = r.log.filter((e) => e.name === 'chunk').map((e) => e.payload);
    expect(chunks[0]!.data).toBeInstanceOf(Uint8Array);
    expect(chunks[0]!.text).toMatch(/^\[event-stream frame \d+B · event:messageStart\]/);
    expect(chunks.some((c) => c.text.includes('"text":"binary'))).toBe(true);
    r.assertOrdering();
  });

  it('error fault: request → fault, with the fault in the payload', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).fail(faults.overloaded());
    await ask(mock).catch(() => {});
    const fault = r.log.find((e) => e.name === 'fault')!;
    expect(fault.payload.fault).toMatchObject({ type: 'error', error: { kind: 'overloaded' } });
    expect(fault.payload.entry.status).toBe(503);
    expect(r.log.some((e) => e.name === 'response')).toBe(false);
    r.assertOrdering();
  });

  it('stream cut: request → exactly afterChunks chunks → fault', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).fail(faults.streamCut({ afterChunks: 4 }));
    await (async () => {
      for await (const _ of (await ask(mock, { stream: true })) as any);
    })().catch(() => {});
    const id = r.log[0]!.id;
    expect(r.sequence(id)).toBe('request chunk chunk chunk chunk fault');
    r.assertOrdering();
  });

  it('stream error: the native error frame is the last chunk before fault', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).fail(faults.streamError({ afterChunks: 2 }));
    await (async () => {
      for await (const _ of (await ask(mock, { stream: true })) as any);
    })().catch(() => {});
    const chunks = r.log.filter((e) => e.name === 'chunk');
    expect(chunks).toHaveLength(3);
    expect(chunks.at(-1)!.payload.text).toContain('"error"');
    r.assertOrdering();
  });

  it('timeout: fault fires once the client gives up', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    mock.when({}).fail(faults.timeout());
    await ask(mock, {}, { timeout: 150 }).catch(() => {});
    await vi.waitFor(() => expect(r.log.some((e) => e.name === 'fault')).toBe(true));
    expect(r.log.find((e) => e.name === 'fault')!.payload.fault.type).toBe('timeout');
    r.assertOrdering();
  });

  it('unmatched: request → unmatched → response (400 in strict, 200 otherwise)', async () => {
    mock = await createMockLLM({ strict: true });
    const r = recorder(mock);
    await ask(mock).catch(() => {});
    const id = r.log[0]!.id;
    expect(r.sequence(id)).toBe('request unmatched response');
    expect(r.log.at(-1)!.payload.entry.status).toBe(400);
    r.assertOrdering();
  });

  it('validation errors still get request → response', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    const claude = new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'k', maxRetries: 0 });
    await claude.messages.create({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] } as any).catch(() => {});
    expect(r.sequence(r.log[0]!.id)).toBe('request response');
    expect(r.log.at(-1)!.payload.entry.status).toBe(400);
  });

  it('non-chat endpoints emit request → response and never unmatched', async () => {
    mock = await createMockLLM();
    const r = recorder(mock);
    for await (const _ of openai(mock).models.list());
    expect(r.sequence(r.log[0]!.id)).toBe('request response');
  });
});

describe('listener safety', () => {
  it('a throwing listener never breaks the response; the error goes to console.error', async () => {
    mock = await createMockLLM();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.on('request', () => {
      throw new Error('boom');
    });
    mock.on('chunk', () => {
      throw new Error('chunk boom');
    });
    mock.when({}).reply('still works');
    const r = await ask(mock);
    expect(r.choices[0]!.message.content).toBe('still works');
    const stream = await ask(mock, { stream: true });
    let text = '';
    for await (const c of stream as any) text += c.choices[0]?.delta?.content ?? '';
    expect(text).toBe('still works');
    expect(errors).toHaveBeenCalledWith('[mock-llm] "request" listener threw:', expect.objectContaining({ message: 'boom' }));
    expect(errors).toHaveBeenCalledWith('[mock-llm] "chunk" listener threw:', expect.objectContaining({ message: 'chunk boom' }));
  });

  it('a rejecting async listener is reported, not unhandled', async () => {
    mock = await createMockLLM();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.on('response', async () => {
      throw new Error('async boom');
    });
    mock.when({}).reply('ok');
    await ask(mock);
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith('[mock-llm] async "response" listener failed:', expect.objectContaining({ message: 'async boom' })),
    );
  });

  it('off() removes a listener; listeners survive reset()', async () => {
    mock = await createMockLLM();
    const seen: string[] = [];
    const listener = () => seen.push('x');
    mock.on('response', listener);
    mock.reset();
    mock.when({}).reply('ok');
    await ask(mock);
    expect(seen).toEqual(['x']);
    mock.off('response', listener);
    await ask(mock);
    expect(seen).toEqual(['x']);
  });
});
