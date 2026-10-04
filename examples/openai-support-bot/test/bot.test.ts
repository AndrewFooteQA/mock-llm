import OpenAI from 'openai';
import { createMockLLM, edge, faults } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { SupportBot, SYSTEM_PROMPT } from '../src/bot.js';

// One mock per test file; rules and the journal are reset after each test.
// strict: any LLM request a test didn't script fails that test, even though
// SupportBot swallows API errors and shows "busy" instead.
// contextWindow: prompts over ~2000 (approximate) tokens get OpenAI's real context-length error.
const mock = useMockLLM({ strict: true, contextWindow: { 'gpt-4o': 2000 } });

// The only test-specific wiring: point the real SDK at the mock.
const bot = (opts: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}) =>
  new SupportBot(new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0, ...opts }));

describe('SupportBot', () => {
  it('answers questions and sends the right prompt', async () => {
    mock.when(/refund/i).reply('Refunds take 5 business days.');

    expect(await bot().answer('How do refunds work?')).toEqual({ kind: 'answer', text: 'Refunds take 5 business days.' });

    // Assert on what the app sent, not just what it showed.
    expect(mock).toHaveReceivedRequest({ model: 'gpt-4o', system: SYSTEM_PROMPT, maxTokens: 300 });
    expect(mock).toHaveReceivedPrompt('How do refunds work?', { in: 'lastUser' });
  });

  it('handles refusals', async () => {
    mock.when({}).reply(edge.refusal());
    expect((await bot().answer('something sketchy')).kind).toBe('refusal');
  });

  it('marks truncated answers', async () => {
    mock.when({}).reply(edge.truncated('Here are the steps: first open settings, then'));
    const a = await bot().answer('How do I reset my password?');
    expect(a.kind).toBe('truncated');
    expect(a.text.endsWith('…')).toBe(true);
  });

  it('escapes HTML/script in model output', async () => {
    mock.when({}).reply(edge.promptInjection());
    const a = await bot().answer('hi');
    expect(a.text).not.toContain('<script>');
    expect(a.text).toContain('&lt;script&gt;');
  });

  it('recovers from a transient 429 via SDK retries', async () => {
    mock.when({}).reply('All good.');
    mock.when({}).once().fail(faults.rateLimit({ retryAfter: 0.01 })); // latest rule wins, then expires

    expect(await bot({ maxRetries: 2 }).answer('hello')).toEqual({ kind: 'answer', text: 'All good.' });
    expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]);
    expect(mock).toHaveReceivedRequestTimes(2);
  });

  it('degrades gracefully during an outage', async () => {
    mock.when({}).fail(faults.overloaded());
    expect((await bot().answer('hello')).kind).toBe('unavailable');
  });

  it('degrades gracefully on timeouts', async () => {
    mock.when({}).fail(faults.timeout());
    expect((await bot({ timeout: 200 }).answer('hello')).kind).toBe('unavailable');
  });

  it('strict mode catches an unscripted question the bot would hide', async () => {
    mock.when(/refund/i).reply('Refunds take 5 business days.');

    // No rule for this: the bot swallows the 400 and the user just sees "busy"…
    expect((await bot().answer('Where is my order?')).kind).toBe('unavailable');

    // …but the mock knows, and would fail this test in afterEach. Here we assert it explicitly:
    expect(mock).not.toHaveNoUnmatchedRequests();
    expect(() => mock.assertNoUnmatched()).toThrow(/UNEXPECTED LLM REQUEST[\s\S]*lastUserMessage: "Where is my order\?"/);
    mock.journal.clear(); // acknowledged, so strict mode doesn't fail this demo test
  });

  it('asks the user to shorten a question that exceeds the context window', async () => {
    mock.when({}).reply('never sent');
    const a = await bot().answer('Please help with this. '.repeat(400)); // ~9,200 chars ≈ 2,300 tokens
    expect(a.kind).toBe('too_long');
    expect(mock.journal.last()!.fault).toMatchObject({ error: { kind: 'context_length', details: { limit: 2000 } } });
    expect(mock).toHaveReceivedRequestTimes(1); // a 400 is not retried
  });

  it('survives seeded chaos (failures name the seed to replay)', async () => {
    // 30% of requests get a random rate limit / outage. Replay a failure with MOCK_LLM_SEED=<seed>.
    const chaotic = await createMockLLM({ seed: 2024, chaos: { rate: 0.3 } });
    try {
      chaotic.default().reply('All good.');
      const chaosBot = new SupportBot(new OpenAI({ baseURL: chaotic.urls.openai, apiKey: 'test', maxRetries: 0 }));
      const kinds: string[] = [];
      for (let i = 0; i < 12; i++) kinds.push((await chaosBot.answer('hello')).kind);

      const replay = `replay with MOCK_LLM_SEED=${chaotic.seed}`;
      expect(kinds.every((k) => k === 'answer' || k === 'unavailable'), replay).toBe(true); // never crashes
      expect(kinds, replay).toContain('unavailable');
      expect(kinds, replay).toContain('answer');
    } finally {
      await chaotic.stop();
    }
  });

  it('never crashes under content chaos (refusals, empty and truncated answers)', async () => {
    const chaotic = await createMockLLM({ seed: 7, chaos: { rate: 0.6, weights: { refusal: 1, empty: 1, truncated: 1 } } });
    try {
      chaotic.default().reply('Refunds take 5 business days from when we receive your return.');
      const chaosBot = new SupportBot(new OpenAI({ baseURL: chaotic.urls.openai, apiKey: 'test', maxRetries: 0 }));
      const kinds = new Set<string>();
      for (let i = 0; i < 20; i++) kinds.add((await chaosBot.answer('How do refunds work?')).kind);

      const replay = `replay with MOCK_LLM_SEED=${chaotic.seed}`;
      expect([...kinds].sort(), replay).toEqual(['answer', 'refusal', 'truncated']); // each handled, never thrown
      // The journal says exactly what chaos did:
      expect(new Set(chaotic.journal.all().map((e) => e.chaos?.behaviour ?? 'none')), replay).toEqual(new Set(['none', 'refusal', 'empty', 'truncated']));
    } finally {
      await chaotic.stop();
    }
  });

  it('stays within a token budget', async () => {
    mock.when({}).replyLorem({ tokens: 120 });
    await bot().answer('Tell me about your store');
    expect(mock).toHaveUsedTokensLessThan(100, { kind: 'input' });
  });
});
