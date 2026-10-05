// Deliberately failing (run by test/check-expected-failures.mjs, never by `vitest run`):
// proves the safety nets fail a test even when the app swallows every error.
import OpenAI from 'openai';
import { useMockLLM } from 'mock-llm/vitest';
import { expect, it } from 'vitest';
import { SupportBot } from '../../src/bot.js';

const mock = useMockLLM({ strict: true });
const bot = () => new SupportBot(new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0 }));

it('an unmet expectation step and an unscripted request both fail the test, though the bot hides them', async () => {
  await mock.load({
    rules: [
      {
        name: 'refund',
        when: { lastUserMessage: 'refund' },
        // The bot sends its real system prompt, not this one: the expectation fails, but the reply is still sent.
        steps: [{ reply: 'Refunds take 5 days.', expectRequest: { system: '/you are a pirate/i' } }],
      },
    ],
  });
  expect((await bot().answer('refund?')).text).toBe('Refunds take 5 days.');
  // Not scripted: strict mode answers with an error, which the bot turns into a friendly message.
  expect((await bot().answer('Where is my order?')).kind).toBe('unavailable');
  // The test body passes. The failure comes from useMockLLM's afterEach, with both reports.
});
