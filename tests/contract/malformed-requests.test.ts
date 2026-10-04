import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { useMockLLM } from '../../src/testing/vitest.js';

// A body the adapter can't read (e.g. a null message) must get the provider's native 400, which SDKs never retry,
// not a mock-internal 500 that SDKs retry and then surface as a generic server error.
const mock = useMockLLM();

describe('malformed request bodies get a native, non-retried 400', () => {
  it('openai: chat completions and Responses → BadRequestError', async () => {
    const client = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 2 });
    const chat = await client.chat.completions.create({ model: 'gpt-4o', messages: [null] } as any).catch((e) => e);
    expect(chat).toBeInstanceOf(OpenAI.BadRequestError);
    expect(chat.message).toContain('Invalid request body');
    const responses = await client.responses.create({ model: 'gpt-4o', input: [null] } as any).catch((e) => e);
    expect(responses).toBeInstanceOf(OpenAI.BadRequestError);
    expect(mock.journal.all().map((e) => e.status)).toEqual([400, 400]); // maxRetries: 2, yet no retries
  });

  it('openai: a function tool without its `function` object → BadRequestError', async () => {
    const client = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 2 });
    const err = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function' }] } as any).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect(mock.journal.count()).toBe(1);
  });

  // The Gemini and Bedrock SDKs drop nulls before sending, so these bodies only come from hand-built or other clients.
  it('gemini and bedrock: native envelopes for bodies their SDKs would never send', async () => {
    const post = (path: string, body: unknown) =>
      fetch(mock.urls.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const gemini = await post('/gemini/v1beta/models/gemini-2.5-flash:generateContent', { contents: [{ role: 'user', parts: [null] }] });
    expect(gemini.status).toBe(400);
    expect(((await gemini.json()) as any).error).toMatchObject({ code: 400, status: 'INVALID_ARGUMENT' });
    const bedrock = await post('/bedrock/model/x/converse', { messages: [null] });
    expect(bedrock.status).toBe(400);
    expect(bedrock.headers.get('x-amzn-errortype')).toMatch(/^ValidationException/);
  });
});
