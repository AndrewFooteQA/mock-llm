import OpenAI from 'openai';
import { it } from 'vitest';
import { useMockLLM } from '../../../src/testing/vitest.js';

// Not strict: unmet scenario expectations fail the test on their own.
const mock = useMockLLM();
const tools = [{ type: 'function' as const, function: { name: 'lookup_order', parameters: { type: 'object' } } }];

async function agent(toolOutput: unknown) {
  const c = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 0 });
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'refund A-1?' }];
  const first = (await c.chat.completions.create({ model: 'gpt-4o', messages, tools })).choices[0]!.message;
  messages.push(first, { role: 'tool', tool_call_id: first.tool_calls![0]!.id, content: JSON.stringify(toolOutput) });
  return (await c.chat.completions.create({ model: 'gpt-4o', messages, tools })).choices[0]!.message.content;
}

const scenario = {
  rules: [
    {
      name: 'refund-flow',
      when: { tool: 'lookup_order' },
      steps: [{ toolCall: { name: 'lookup_order', input: { order_id: 'A-1' } } }, { expectToolResult: { name: 'lookup_order', content: { refundable: true } }, reply: 'Refund approved.' }],
    },
  ],
};

it('agent sends the expected tool result', async () => {
  await mock.load(scenario);
  await agent({ refundable: true });
});

it('agent sends the wrong tool result', async () => {
  await mock.load(scenario);
  await agent({ refundable: false }); // the app flow completes; the test fails afterwards
});
