import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import { OAuth2Client } from 'google-auth-library';
import OpenAI from 'openai';
import { createMockLLM, type MockLLMOptions } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { bedrockTitanEmbedder, geminiEmbedder, openaiEmbedder, type Embedder } from '../src/embedders.js';
import { answer, cosine, KnowledgeBase, pickModel, SYSTEM_PROMPT, type Doc } from '../src/kb.js';
import { anthropicCounter, bedrockCounter, geminiCounter } from '../src/tokens.js';

// The models the provider "has" (served by models.list), and a price for the one the app picks, so cost assertions
// don't depend on built-in prices.
const options: MockLLMOptions = {
  seed: 7,
  strict: true,
  models: ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'text-embedding-3-small'],
  pricing: { 'claude-sonnet-5-5': { input: 3, output: 15 } },
};
const mock = useMockLLM(options);

const openai = () => new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0 });
const anthropic = () => new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'test', maxRetries: 0 });
const gemini = () => new GoogleGenAI({ apiKey: 'test', httpOptions: { baseUrl: mock.urls.gemini } });
const vertex = () => {
  // A static OAuth token: the SDK sends `Authorization: Bearer …` without looking up Google credentials.
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'test-token', expiry_date: Date.now() + 3_600_000 });
  return new GoogleGenAI({ vertexai: true, project: 'kb-project', location: 'us-central1', googleAuthOptions: { authClient }, httpOptions: { baseUrl: mock.urls.gemini } });
};
const bedrock = () => new BedrockRuntimeClient({ endpoint: mock.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, maxAttempts: 1 });

// An FAQ: questions are embedded, answers go into the prompt.
const FAQ: Doc[] = [
  { id: 'reset', key: 'How do I reset my password?', text: 'Use "Forgot password" on the sign-in page; the link is valid for 30 minutes.' },
  { id: 'refund', key: 'Can I get a refund?', text: 'Refunds are available within 14 days of purchase from Settings → Billing.' },
  { id: 'export', key: 'How do I export my data?', text: 'Settings → Privacy → Export creates a ZIP of your data within 24 hours.' },
  { id: 'delete', key: 'How do I delete my account?', text: 'Settings → Account → Delete removes your account after a 7-day grace period.' },
];

/** The mock's embeddings are deterministic per text, not semantic: the same text always gets the same vector. */
describe('embeddings through every provider SDK', () => {
  const cases: Array<[string, () => Embedder, number]> = [
    ['OpenAI (SDK default: base64, decoded by the SDK)', () => openaiEmbedder(openai()), 1536],
    ["OpenAI (encoding_format: 'float')", () => openaiEmbedder(openai(), { encoding: 'float' }), 1536],
    ['Gemini AI Studio (batch embedContent)', () => geminiEmbedder(gemini(), { dimensions: 256 }), 256],
    ['Gemini Vertex AI (text-embedding-005 → :predict)', () => geminiEmbedder(vertex(), { model: 'text-embedding-005', dimensions: 256 }), 256],
    ['Bedrock Titan v2 (InvokeModel)', () => bedrockTitanEmbedder(bedrock(), { dimensions: 512 }), 512],
  ];

  it.each(cases)('%s: one vector per text, stable, and unit length', async (_name, make, dims) => {
    const [a, b, again] = await make().embed(['How do I reset my password?', 'Can I get a refund?', 'How do I reset my password?']);
    expect(a).toHaveLength(dims);
    expect(cosine(a!, again!)).toBeCloseTo(1, 5); // same text → same vector
    expect(cosine(a!, b!)).toBeLessThan(0.5);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 4);
    expect(mock).toHaveReceivedRequest({ endpoint: 'embeddings' });
  });

  it('base64 and float encodings decode to the same vectors', async () => {
    const [b64] = await openaiEmbedder(openai()).embed(['hello']);
    const [float] = await openaiEmbedder(openai(), { encoding: 'float' }).embed(['hello']);
    b64!.forEach((v, i) => expect(v).toBeCloseTo(float![i]!, 6));
    expect(mock.journal.all({ endpoint: 'embeddings' }).map((e) => e.request.raw.encoding_format)).toEqual(['base64', 'float']);
  });

  it('Vertex AI requests go to :predict with the OAuth token', async () => {
    await geminiEmbedder(vertex(), { model: 'text-embedding-005' }).embed(['hi']);
    const e = mock.journal.last()!;
    expect(e.path).toMatch(/\/projects\/kb-project\/locations\/us-central1\/publishers\/google\/models\/text-embedding-005:predict$/);
    expect(e.request.headers.authorization).toBe('Bearer test-token');
  });
});

describe('token counting before sending', () => {
  const system = SYSTEM_PROMPT;
  const user = 'Passages: [1] something long enough to count. Question: what?';
  it.each([
    ['Anthropic count_tokens', () => anthropicCounter(anthropic(), 'claude-sonnet-5-5')],
    ['Gemini countTokens', () => geminiCounter(gemini(), 'gemini-2.5-flash')],
    ['Bedrock CountTokens', () => bedrockCounter(bedrock(), 'anthropic.claude-sonnet-5-5')],
  ])('%s returns a positive count that grows with the prompt', async (_name, make) => {
    const count = make();
    const short = await count(system, user);
    const long = await count(system, user + ' more words'.repeat(50));
    expect(short).toBeGreaterThan(5);
    expect(long).toBeGreaterThan(short);
    expect(mock).toHaveReceivedRequest({ endpoint: 'count_tokens' });
  });
});

describe('answer (retrieval-augmented)', () => {
  const kb = async () => {
    const k = new KnowledgeBase(openaiEmbedder(openai()));
    await k.add(FAQ);
    return k;
  };

  it('picks a model from models.list', async () => {
    expect(await pickModel(anthropic())).toBe('claude-sonnet-5-5');
    expect(mock).toHaveReceivedRequest({ endpoint: 'models' });
  });

  it('fails clearly when the provider lists no Claude model', async () => {
    // A second mock whose models endpoint lists no Claude model.
    const bare = await createMockLLM({ models: ['text-embedding-3-small'] });
    try {
      const client = new Anthropic({ baseURL: bare.urls.anthropic, apiKey: 'test', maxRetries: 0 });
      await expect(pickModel(client)).rejects.toThrow('No Claude model available');
    } finally {
      await bare.stop();
    }
  });

  it('puts the matching passage first in the prompt and answers from it, within budget', async () => {
    mock.when({ provider: 'anthropic', endpoint: 'chat', lastUserMessage: /Question: How do I reset my password\?/ }).reply('Use "Forgot password" on the sign-in page.');

    const result = await answer(await kb(), anthropic(), 'How do I reset my password?', { countTokens: anthropicCounter(anthropic(), 'claude-sonnet-5-5') });

    expect(result.text).toBe('Use "Forgot password" on the sign-in page.');
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.passages[0]).toBe(FAQ[0]!.text); // identical question text → cosine 1 → ranked first
    // What reached the model: the top passage, numbered first, and the system prompt.
    expect(mock).toHaveReceivedPrompt(`[1] ${FAQ[0]!.text}`, { in: 'user' });
    expect(mock).toHaveReceivedPrompt(SYSTEM_PROMPT, { in: 'system' });
    // Cost of the chat call, priced with the custom entry above.
    expect(mock).toCostLessThan(0.01);
    const cost = mock.journal.cost();
    expect(cost.unpriced).toEqual([]);
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.byModel['claude-sonnet-5-5']!.usd).toBe(cost.total);
  });

  it('drops the lowest-ranked passages until the prompt fits the token budget', async () => {
    mock.when({}).reply('Within 14 days.');
    const count = anthropicCounter(anthropic(), 'claude-sonnet-5-5');
    const roomy = await answer(await kb(), anthropic(), 'Can I get a refund?', { countTokens: count, k: 4, maxPromptTokens: 10_000 });
    const tight = await answer(await kb(), anthropic(), 'Can I get a refund?', { countTokens: count, k: 4, maxPromptTokens: 60 });

    expect(roomy.passages).toHaveLength(4);
    expect(tight.passages.length).toBeLessThan(4);
    expect(tight.passages[0]).toBe(FAQ[1]!.text); // the best match is never dropped
    // Either the prompt fits, or only the best passage is left (it's never dropped).
    expect(tight.promptTokens <= 60 || tight.passages.length === 1).toBe(true);
    expect(mock.journal.all({ endpoint: 'count_tokens' }).length).toBeGreaterThan(2);
  });
});
