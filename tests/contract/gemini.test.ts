import { ApiError, GoogleGenAI, Type } from '@google/genai';
import type { OAuth2Client as OAuth2ClientType } from 'google-auth-library';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { edge, faults } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM({ seed: 7 });
// The google-auth-library copy @google/genai itself depends on, as in a real app. The compat matrix runs older SDK
// releases built against an older google-auth-library, whose auth client the SDK can't use from a newer copy.
const require = createRequire(import.meta.url);
const { OAuth2Client } = createRequire(require.resolve('@google/genai'))('google-auth-library') as { OAuth2Client: typeof OAuth2ClientType };
const MODEL = 'gemini-2.5-flash';
const ai = () => new GoogleGenAI({ apiKey: 'test', httpOptions: { baseUrl: mock.urls.gemini } });

const weather = {
  functionDeclarations: [{ name: 'get_weather', parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ['city'] } }],
};

describe('gemini: generateContent', () => {
  it('returns scripted text with realistic shape', async () => {
    mock.when({ provider: 'gemini', lastUserMessage: 'hello' }).reply('Hi from Gemini!');
    const r = await ai().models.generateContent({ model: MODEL, contents: 'hello', config: { systemInstruction: 'Be nice.' } });
    expect(r.text).toBe('Hi from Gemini!');
    expect(r.candidates![0]!.finishReason).toBe('STOP');
    expect(r.usageMetadata!.promptTokenCount).toBeGreaterThan(0);
    expect(mock.journal.last()!.request.system).toBe('Be nice.');
    expect(mock.journal.last()!.request.model).toBe(MODEL);
  });

  it('streams text chunks', async () => {
    mock.when({}).reply('alpha beta gamma');
    let text = '';
    for await (const chunk of await ai().models.generateContentStream({ model: MODEL, contents: 'x' })) text += chunk.text ?? '';
    expect(text).toBe('alpha beta gamma');
  });

  it('function calling loop', async () => {
    mock.when({ tool: 'get_weather' }).replyToolCall('get_weather', { city: 'Paris' });
    mock.when({ hasToolResult: true }).reply('Sunny in Paris.');
    const first = await ai().models.generateContent({ model: MODEL, contents: 'Weather?', config: { tools: [weather] } });
    expect(first.functionCalls![0]).toMatchObject({ name: 'get_weather', args: { city: 'Paris' } });

    const second = await ai().models.generateContent({
      model: MODEL,
      config: { tools: [weather] },
      contents: [
        { role: 'user', parts: [{ text: 'Weather?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }] },
      ],
    });
    expect(second.text).toBe('Sunny in Paris.');
  });

  it('structured output from responseSchema', async () => {
    mock.when({ responseFormat: 'json_schema' }).replyFromSchema();
    const r = await ai().models.generateContent({
      model: MODEL,
      contents: 'Give me a recipe',
      config: {
        responseMimeType: 'application/json',
        responseSchema: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, minutes: { type: Type.INTEGER } }, required: ['name', 'minutes'] },
      },
    });
    const parsed = JSON.parse(r.text!);
    expect(typeof parsed.name).toBe('string');
    expect(Number.isInteger(parsed.minutes)).toBe(true);
  });

  it('safety block, truncation and malformed function calls', async () => {
    mock.when('unsafe').reply(edge.contentFilter());
    mock.when('long').reply(edge.truncated('a b c d e f'));
    mock.when('bad tool').reply(edge.malformedToolArgs('get_weather'));
    expect((await ai().models.generateContent({ model: MODEL, contents: 'unsafe' })).candidates![0]!.finishReason).toBe('SAFETY');
    expect((await ai().models.generateContent({ model: MODEL, contents: 'long' })).candidates![0]!.finishReason).toBe('MAX_TOKENS');
    const r = await ai().models.generateContent({ model: MODEL, contents: 'bad tool', config: { tools: [weather] } });
    expect(r.candidates![0]!.finishReason).toBe('MALFORMED_FUNCTION_CALL');
    expect(r.functionCalls).toBeUndefined();
  });
});

describe('gemini: errors', () => {
  it('native error envelopes become ApiError with status', async () => {
    mock.when('busy').fail(faults.rateLimit({ retryAfter: 0 }));
    mock.when('down').fail(faults.overloaded());
    const busy = await ai().models.generateContent({ model: MODEL, contents: 'busy' }).catch((e) => e);
    expect(busy).toBeInstanceOf(ApiError);
    expect(busy.status).toBe(429);
    expect(busy.message).toContain('RESOURCE_EXHAUSTED');
    const down = await ai().models.generateContent({ model: MODEL, contents: 'down' }).catch((e) => e);
    expect(down.status).toBe(503);
  });

  it('mid-stream error chunk raises ApiError', async () => {
    mock.when({}).fail(faults.streamError({ afterChunks: 2, error: { kind: 'overloaded' } }));
    const run = async () => {
      for await (const _ of await ai().models.generateContentStream({ model: MODEL, contents: 'x' }));
    };
    await expect(run()).rejects.toMatchObject({ status: 503 });
  });

  it('mid-stream error arrives as its own network read, even for a slow reader (regression: CI on Linux)', async () => {
    // The SDK only recognises the bare error JSON if JSON.parse succeeds on a single read. A loaded client that reads
    // late used to get the last SSE chunk and the error in one read, and raised "Incomplete JSON segment at the end".
    mock.when({}).fail(faults.streamError({ afterChunks: 2, error: { kind: 'overloaded' } }));
    const res = await fetch(`${mock.urls.gemini}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }),
    });
    const reader = res.body!.getReader();
    const reads: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads.push(new TextDecoder().decode(value));
      await new Promise((r) => setTimeout(r, 20)); // a slow consumer
    }
    const last = reads.at(-1)!;
    expect(() => JSON.parse(last)).not.toThrow();
    expect(JSON.parse(last)).toMatchObject({ error: { code: 503, status: 'UNAVAILABLE' } });
    expect(reads.slice(0, -1).join('')).toContain('data:');
  });
});

describe('gemini: other endpoints', () => {
  it('countTokens, embedContent and models.list', async () => {
    const n = await ai().models.countTokens({ model: MODEL, contents: 'hello world' });
    expect(n.totalTokens).toBeGreaterThan(0);
    const e = await ai().models.embedContent({ model: 'gemini-embedding-001', contents: ['a', 'b'] });
    expect(e.embeddings).toHaveLength(2);
    expect(e.embeddings![0]!.values!.length).toBe(768);
    const names: string[] = [];
    for await (const m of await ai().models.list()) names.push(m.name!);
    expect(names).toContain(`models/${MODEL}`);
  });

  it('Vertex AI: embedContent for non-Gemini models (`:predict`) and Gemini models (`:embedContent`)', async () => {
    // Static OAuth token: the SDK sends `Authorization: Bearer …` without looking up Google credentials.
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: 'test-token', expiry_date: Date.now() + 3_600_000 });
    const vertex = new GoogleGenAI({ vertexai: true, project: 'p', location: 'us-central1', googleAuthOptions: { authClient }, httpOptions: { baseUrl: mock.urls.gemini } });

    const predicted = await vertex.models.embedContent({ model: 'text-embedding-005', contents: ['hello', 'world'], config: { outputDimensionality: 8 } });
    expect(predicted.embeddings).toHaveLength(2);
    expect(predicted.embeddings![0]!.values).toHaveLength(8);
    expect(predicted.embeddings![0]!.statistics).toEqual({ tokenCount: expect.any(Number), truncated: false });
    expect(mock.journal.last()!.path).toBe('/v1beta1/projects/p/locations/us-central1/publishers/google/models/text-embedding-005:predict');

    const gemini = await vertex.models.embedContent({ model: 'gemini-embedding-2', contents: 'hello' });
    expect(gemini.embeddings![0]!.values).toHaveLength(768);
    expect(mock.journal.all().map((e) => [e.endpoint, e.status])).toEqual([
      ['embeddings', 200],
      ['embeddings', 200],
    ]);
  });
});
