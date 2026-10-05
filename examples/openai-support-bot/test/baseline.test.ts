import OpenAI from 'openai';
import type { ScenarioFile } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { SupportBot } from '../src/bot.js';

// One shared baseline for the whole file, re-applied fresh by the reset before every test. Strict mode stays on, so
// a question neither the baseline nor the test scripted fails the test.
const mock = useMockLLM({ scenarioFiles: ['test/scenarios/support-baseline.yaml'], strict: true });
const bot = () => new SupportBot(new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0 }));

describe('SupportBot with a shared YAML baseline', () => {
  it('answers from the baseline', async () => {
    // The bot HTML-escapes model output, so the apostrophe arrives as &#39;.
    expect(await bot().answer('What are your opening hours?')).toEqual({ kind: 'answer', text: 'We&#39;re open 9:00–17:00, Monday to Friday.' });
    expect(mock.journal.last()!.matchedBy).toBe('opening-hours');
  });

  it('walks the baseline sequence from its first step', async () => {
    expect((await bot().answer('Where is my order?')).text).toBe('Let me check that for you.');
    expect((await bot().answer('Where is my order?')).text).toBe('It shipped yesterday and arrives tomorrow.');
  });

  it('starts the sequence over in the next test (the baseline is re-applied fresh)', async () => {
    expect((await bot().answer('Where is my order?')).text).toBe('Let me check that for you.');
  });

  it('fires the one-shot outage, then falls back to the default', async () => {
    expect((await bot().answer('I want a refund')).kind).toBe('unavailable');
    expect((await bot().answer('I want a refund')).text).toBe('I can help with orders, refunds and opening hours.');
  });

  it('fires the one-shot outage again in the next test', async () => {
    expect((await bot().answer('Refund please')).kind).toBe('unavailable');
  });

  it("lets a test override the baseline with its own when(), on top of the baseline's other rules", async () => {
    mock.when({ lastUserMessage: /opening hours/i }).reply('Closed today for a public holiday.');
    expect((await bot().answer('Opening hours today?')).text).toBe('Closed today for a public holiday.');
    expect((await bot().answer('Where is my order?')).text).toBe('Let me check that for you.'); // baseline still there
  });

  it("drops the previous test's override (only the baseline survives a reset)", async () => {
    expect((await bot().answer('Opening hours today?')).text).toMatch(/^We/);
  });

  it('typed in-code scenarios load on top of the baseline, like a second file', async () => {
    const extra: ScenarioFile = { rules: [{ name: 'vip', when: { lastUserMessage: '/vip/i' }, reply: 'Welcome back, VIP!' }] };
    await mock.load(extra);
    expect((await bot().answer('I am a VIP')).text).toBe('Welcome back, VIP!');
    expect((await bot().answer('Where is my order?')).text).toBe('Let me check that for you.');
  });
});
