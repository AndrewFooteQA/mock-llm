import OpenAI from 'openai';
import { it } from 'vitest';
import { useMockLLM } from '../../../src/testing/vitest.js';

// An "app" that hides every LLM error from its caller.
async function forgivingApp(client: OpenAI, question: string): Promise<string> {
  try {
    const r = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: question }] });
    return r.choices[0]!.message.content ?? '';
  } catch {
    return 'Sorry, something went wrong.';
  }
}

const mock = useMockLLM({ strict: true });
const client = () => new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 0 });

it('unscripted request is swallowed by the app', async () => {
  // No rule matches; the app catches the 400 and the test body itself would pass…
  await forgivingApp(client(), 'Where is my order?');
});

it('scripted request passes', async () => {
  mock.when('order').reply('It shipped.');
  await forgivingApp(client(), 'Where is my order?');
});
