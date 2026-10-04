import { describe, expect, it, jest } from '@jest/globals';
import OpenAI from 'openai';
import { useMockLLM } from '../../../dist/testing/jest.js';

const mock = useMockLLM();
const client = () => new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 0 });

describe('mock-llm/jest matchers', () => {
  it('pass, negate, and fail with the journal excerpt', async () => {
    mock.when({ tool: 'lookup' }).replyToolCall('lookup', { id: 7 }).then.reply('done');
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const messages = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'find 7' }];
    const first = (await client().chat.completions.create({ model: 'gpt-4o', messages, tools })).choices[0].message;
    messages.push(first, { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '{"found":true}' });
    await client().chat.completions.create({ model: 'gpt-4o', messages, tools });

    expect(mock).toHaveReceivedRequestTimes(2);
    expect(mock).toHaveReceivedRequest({ system: 'Be brief.', tools: ['lookup'] });
    expect(mock).toHaveReceivedPrompt(expect.stringContaining('find'));
    expect(mock).toHaveOfferedTool('lookup');
    expect(mock).not.toHaveOfferedTool('delete');
    expect(mock).toHaveRequestedTool('lookup', { id: 7 });
    expect(mock).toHaveReturnedToolResult('lookup', { found: true });
    expect(mock).toHaveToolTrajectory(['lookup']);
    expect(mock).toHaveUsedTokensLessThan(1000);
    expect(mock).toHaveNoUnmatchedRequests();
    expect(() => expect(mock).toHaveToolTrajectory(['lookup', 'delete'])).toThrow(/Expected mock-llm to have a returned tool trajectory/);
    expect(() => expect(mock).not.toHaveOfferedTool('lookup')).toThrow(/Expected mock-llm NOT to have offered tool "lookup"/);
  });

  it("leaves Jest's built-in spy matchers alone", () => {
    const spy = jest.fn();
    spy('x');
    expect(spy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('x');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
