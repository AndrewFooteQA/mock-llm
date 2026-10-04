import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseCommand, ValidationException } from '@aws-sdk/client-bedrock-runtime';
import { ApiError, GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockLLM, type MockLLM } from '../../src/index.js';

let mock: MockLLM;
afterEach(async () => mock?.stop());

const LIMIT = 100; // tokens (~400 characters)
const BIG = 'word '.repeat(200); // ~1000 chars → ~250 tokens
const SMALL = 'hello';

const bedrock = (m: MockLLM) => new BedrockRuntimeClient({ endpoint: m.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, maxAttempts: 1 });

/** Send `text` through each official SDK; resolves on success, rejects with the SDK's error. */
const send: Record<string, (m: MockLLM, text: string) => Promise<unknown>> = {
  'openai chat': (m, text) => new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: text }] }),
  'openai responses': (m, text) => new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 }).responses.create({ model: 'gpt-4.1', input: text }),
  anthropic: (m, text) => new Anthropic({ baseURL: m.urls.anthropic, apiKey: 'k', maxRetries: 0 }).messages.create({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: text }] }),
  gemini: (m, text) => new GoogleGenAI({ apiKey: 'k', httpOptions: { baseUrl: m.urls.gemini } }).models.generateContent({ model: 'gemini-2.5-flash', contents: text }),
  'bedrock converse': (m, text) => bedrock(m).send(new ConverseCommand({ modelId: 'anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text }] }] })),
};

/** The SDK's real error type and native message for each provider. */
const expectNativeError: Record<string, (err: any, inputTokens: number) => void> = {
  'openai chat': (err, n) => {
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect(err.code).toBe('context_length_exceeded');
    expect(err.message).toContain(`maximum context length is ${LIMIT} tokens. However, your messages resulted in ${n} tokens`);
  },
  'openai responses': (err, n) => {
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect(err.message).toContain(`resulted in ${n} tokens`);
  },
  anthropic: (err, n) => {
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err.error).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${n} tokens > ${LIMIT} maximum` } });
  },
  gemini: (err, n) => {
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain(`The input token count (${n}) exceeds the maximum number of tokens allowed (${LIMIT})`);
    expect(err.message).toContain('INVALID_ARGUMENT');
  },
  'bedrock converse': (err) => {
    expect(err).toBeInstanceOf(ValidationException);
    expect(err.message).toBe('Input is too long for requested model.');
  },
};

describe.each(Object.keys(send))('contextWindow through the %s SDK', (name) => {
  it('rejects an oversized prompt with the native error; a small one passes', async () => {
    mock = await createMockLLM({ contextWindow: { '*': LIMIT } });
    mock.default().reply('ok');

    await expect(send[name]!(mock, SMALL)).resolves.toBeDefined();
    const err = await send[name]!(mock, BIG).catch((e) => e);
    const entry = mock.journal.last()!;
    expectNativeError[name]!(err, entry.request ? (entry.fault as any).error.details.inputTokens : 0);
    expect(entry).toMatchObject({ status: 400, matchedBy: 'contextWindow', fault: { type: 'error', error: { kind: 'context_length', details: { limit: LIMIT } } } });
    expect((entry.fault as any).error.details.inputTokens).toBeGreaterThan(LIMIT);
  });
});

describe('contextWindow behaviour', () => {
  const ask = (m: MockLLM, model: string, text: string) =>
    new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({ model, messages: [{ role: 'user', content: text }] });
  const tokensOf = (m: MockLLM) => (m.journal.last()!.fault as any)?.error?.details;

  it('picks the exact id first, then the longest matching glob', async () => {
    mock = await createMockLLM({ contextWindow: { '*': 10_000, 'gpt-*': 200, 'gpt-4o-*': 150, 'gpt-4o': 120 } });
    mock.default().reply('ok');
    const text = 'x'.repeat(700); // ~175 tokens
    await expect(ask(mock, 'gpt-4o', text)).rejects.toBeInstanceOf(OpenAI.BadRequestError); // exact: 120
    expect(tokensOf(mock).limit).toBe(120);
    await expect(ask(mock, 'gpt-4o-mini', text)).rejects.toBeInstanceOf(OpenAI.BadRequestError); // longest glob: 150
    expect(tokensOf(mock).limit).toBe(150);
    await expect(ask(mock, 'gpt-4.1', text)).resolves.toBeDefined(); // gpt-*: 200
    await expect(ask(mock, 'o4-mini', text)).resolves.toBeDefined(); // *: 10000
  });

  it('a non-wildcard key matches only that exact id (not as a substring)', async () => {
    mock = await createMockLLM({ contextWindow: { 'gpt-4o': 50 } });
    mock.default().reply('ok');
    await expect(ask(mock, 'gpt-4o-mini', 'x'.repeat(400))).resolves.toBeDefined();
    await expect(ask(mock, 'gpt-4o', 'x'.repeat(400))).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });

  it('applies before rules and scenarios; the request is not "unmatched"; fault events fire', async () => {
    mock = await createMockLLM({ strict: true, contextWindow: { '*': LIMIT } });
    const events: string[] = [];
    mock.on('request', () => events.push('request')).on('fault', ({ fault }) => events.push(`fault:${fault.type}`));
    mock.when({}).reply('a scripted reply that never happens');
    await expect(ask(mock, 'gpt-4o', BIG)).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    await expect(ask(mock, 'gpt-4o', `${BIG} [[mock:unicode]]`)).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    expect(events).toEqual(['request', 'fault:error', 'request', 'fault:error']);
    expect(() => mock.assertNoUnmatched()).not.toThrow();
  });

  it('counts the whole conversation, including Responses API memory (previous_response_id)', async () => {
    // First request ≈ 4 tokens; the follow-up carries the stored ~300-char answer as history (≈ 84 tokens).
    mock = await createMockLLM({ contextWindow: { '*': 60 } });
    mock.default().reply('y'.repeat(300)); // a long assistant turn stored as history
    const c = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 0 });
    const first = await c.responses.create({ model: 'gpt-4.1', input: 'short question' });
    await expect(c.responses.create({ model: 'gpt-4.1', input: 'and another short one', previous_response_id: first.id })).rejects.toBeInstanceOf(
      OpenAI.BadRequestError,
    );
    expect((mock.journal.last()!.fault as any).error.details.inputTokens).toBeGreaterThan(60);
  });

  it('faults.contextLengthExceeded({ details }) uses the same native numbers', async () => {
    mock = await createMockLLM();
    const { faults } = await import('../../src/index.js');
    mock.when({}).fail(faults.contextLengthExceeded({ details: { limit: 8192, inputTokens: 9001 } }));
    const err = await ask(mock, 'gpt-4o', 'x').catch((e) => e);
    expect(err.message).toContain('maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens');
  });

  it('rejects invalid windows when the mock is created', async () => {
    await expect(createMockLLM({ contextWindow: { 'gpt-*': 0 } })).rejects.toThrow(/invalid contextWindow\["gpt-\*"\] 0: must be a positive number of tokens/);
    await expect(createMockLLM({ contextWindow: { x: 'big' as any } })).rejects.toThrow(/invalid contextWindow/);
  });
});
