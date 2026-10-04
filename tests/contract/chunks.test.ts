import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseStreamCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { MockLLM } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM();
// Uneven boundaries, mid-word splits and an emoji ZWJ sequence that must stay whole.
const CHUNKS = ['Hel', 'lo, w', 'orld', '! 👩🏽‍💻', ' Done.'];
const TEXT = CHUNKS.join('');

/** Collect the text deltas each official SDK yields while streaming. */
const streams: Record<string, (m: MockLLM) => Promise<string[]>> = {
  'openai chat': async (m) => {
    const s = await new OpenAI({ baseURL: m.urls.openai, apiKey: 'k' }).chat.completions.create({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'x' }] });
    const out: string[] = [];
    for await (const c of s) if (c.choices[0]?.delta?.content) out.push(c.choices[0].delta.content);
    return out;
  },
  'openai responses': async (m) => {
    const s = await new OpenAI({ baseURL: m.urls.openai, apiKey: 'k' }).responses.create({ model: 'gpt-4.1', stream: true, input: 'x' });
    const out: string[] = [];
    for await (const e of s) if (e.type === 'response.output_text.delta') out.push(e.delta);
    return out;
  },
  anthropic: async (m) => {
    const out: string[] = [];
    const s = new Anthropic({ baseURL: m.urls.anthropic, apiKey: 'k' }).messages.stream({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] });
    s.on('text', (t) => out.push(t));
    await s.finalMessage();
    return out;
  },
  gemini: async (m) => {
    const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { baseUrl: m.urls.gemini } });
    const out: string[] = [];
    for await (const c of await ai.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'x' })) if (c.text) out.push(c.text);
    return out;
  },
  'bedrock converse': async (m) => {
    const c = new BedrockRuntimeClient({ endpoint: m.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
    const r = await c.send(new ConverseStreamCommand({ modelId: 'anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text: 'x' }] }] }));
    const out: string[] = [];
    for await (const e of r.stream!) if (e.contentBlockDelta?.delta?.text) out.push(e.contentBlockDelta.delta.text);
    return out;
  },
  'bedrock invoke (claude)': async (m) => {
    const c = new BedrockRuntimeClient({ endpoint: m.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
    const r = await c.send(
      new InvokeModelWithResponseStreamCommand({
        modelId: 'us.anthropic.claude-sonnet-5-5',
        body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] }),
      }),
    );
    const out: string[] = [];
    for await (const e of r.body!) {
      const ev = JSON.parse(new TextDecoder().decode(e.chunk!.bytes));
      if (ev.type === 'content_block_delta') out.push(ev.delta.text);
    }
    return out;
  },
};

describe.each(Object.keys(streams))('exact chunks through the %s SDK', (name) => {
  it('streams exactly the given chunk boundaries', async () => {
    mock.when({}).reply({ chunks: CHUNKS });
    expect(await streams[name]!(mock)).toEqual(CHUNKS);
  });
});

describe('exact chunks: behaviour', () => {
  it('non-streaming requests get the joined text', async () => {
    mock.when({}).reply({ chunks: CHUNKS });
    const r = await new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    expect(r.choices[0]!.message.content).toBe(TEXT);
  });

  it('refusals stream in the given chunks too (OpenAI refusal deltas)', async () => {
    mock.when({}).reply({ content: [{ type: 'text', text: "I can't help.", chunks: ['I ', "can't ", 'help.'] }], stopReason: 'refusal' });
    const s = await new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' }).chat.completions.create({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'x' }] });
    const out: string[] = [];
    for await (const c of s) if ((c.choices[0]?.delta as any)?.refusal) out.push((c.choices[0]!.delta as any).refusal);
    expect(out).toEqual(['I ', "can't ", 'help.']);
  });

  it('chunkIntervalMs paces the stream and is recorded', async () => {
    mock.when({}).reply({ chunks: ['a', 'b', 'c', 'd'] }, { chunkIntervalMs: 40 });
    const t0 = performance.now();
    expect(await streams['anthropic']!(mock)).toEqual(['a', 'b', 'c', 'd']);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(3 * 40); // lower bound only
    expect(mock.journal.last()!.latency).toMatchObject({ chunkIntervalMs: 40 });
  });

  it('inject() keeps chunks consistent (suffix becomes its own final chunk, prefix joins the first)', async () => {
    mock.when('suffix').reply({ chunks: ['A', 'B'] }).inject('!');
    mock.when('prefix').reply({ chunks: ['A', 'B'] }).inject('>', { position: 'prefix' });
    const chunksFor = async (content: string) => {
      const s = await new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' }).chat.completions.create({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content }] });
      const out: string[] = [];
      for await (const c of s) if (c.choices[0]?.delta?.content) out.push(c.choices[0].delta.content);
      return out;
    };
    expect(await chunksFor('suffix')).toEqual(['A', 'B', '!']);
    expect(await chunksFor('prefix')).toEqual(['>A', 'B']);
  });

  it('scenario files: reply: { chunks } with chunkIntervalMs, and clear validation', async () => {
    await mock.load({ rules: [{ when: { lastUserMessage: 'x' }, reply: { chunks: CHUNKS } as any, chunkIntervalMs: 5 }] });
    expect(await streams['gemini']!(mock)).toEqual(CHUNKS);
    expect(mock.journal.last()!.latency).toMatchObject({ chunkIntervalMs: 5 });

    await expect(mock.load({ rules: [{ reply: { chunks: [] } as any }] })).rejects.toThrow(/^scenario: rules\[0\]: invalid chunks \[\]: expected a non-empty array of strings/);
    await expect(mock.load({ rules: [{ reply: { chunks: ['a', 1] } as any }] })).rejects.toThrow(/invalid chunks/);
    await expect(mock.load({ rules: [{ reply: 'a', chunkIntervalMs: -1 }] })).rejects.toThrow(/invalid chunkIntervalMs -1/);
    await expect(mock.load({ rules: [{ fail: 'overloaded', chunkIntervalMs: 10 }] })).rejects.toThrow(/chunkIntervalMs is not supported on fail steps/);
  });
});
