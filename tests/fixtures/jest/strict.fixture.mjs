import { it } from '@jest/globals';
import OpenAI from 'openai';
import { useMockLLM } from '../../../dist/testing/jest.js';

const mock = useMockLLM({ strict: true });
const forgivingApp = async (question) => {
  try {
    const client = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 0 });
    return (await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: question }] })).choices[0].message.content;
  } catch {
    return 'Sorry, something went wrong.';
  }
};

it('unscripted request is swallowed by the app', async () => {
  await forgivingApp('Where is my order?');
});

it('scripted request passes', async () => {
  mock.when('order').reply('It shipped.');
  await forgivingApp('Where is my order?');
});
