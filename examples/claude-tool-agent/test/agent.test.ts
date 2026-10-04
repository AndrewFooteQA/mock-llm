import Anthropic from '@anthropic-ai/sdk';
import { edge } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { AgentError, runAgent } from '../src/agent.js';

const mock = useMockLLM();
const client = () => new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'test', maxRetries: 0 });

/** The tool_result blocks the agent sent in its most recent request (for checks the matchers don't cover). */
const lastToolResults = () =>
  mock.journal.last()!.request.messages.at(-1)!.content.filter((p) => p.type === 'tool_result');

describe('runAgent', () => {
  it('calls a tool, sends the result back, and answers', async () => {
    // Route on conversation state: first ask for the tool, then answer once results arrive.
    // (The latest matching rule wins, so the more specific rule goes last.)
    mock.when({ tool: 'lookup_order' }).replyToolCall('lookup_order', { order_id: 'A-1001' }, { text: 'Let me check.' });
    mock.when({ hasToolResult: true }).replyTemplate('Your order has shipped.');

    const result = await runAgent(client(), 'Where is order A-1001?');

    expect(result).toMatchObject({ answer: 'Your order has shipped.', turns: 2 });
    expect(result.toolCalls).toEqual([{ name: 'lookup_order', input: { order_id: 'A-1001' }, ok: true }]);
    // What the agent actually sent back to the model:
    expect(mock).toHaveReturnedToolResult('lookup_order', { status: 'shipped', eta: '2026-10-08' });
    expect(mock).toHaveToolTrajectory([{ name: 'lookup_order', args: { order_id: 'A-1001' } }]);
  });

  it('runs parallel tool calls and returns all results in one message', async () => {
    mock
      .when({})
      .replyToolCalls([
        { name: 'lookup_order', input: { order_id: 'A-1001' } },
        { name: 'get_weather', input: { city: 'Oslo' } },
      ])
      .then.reply('Shipped, and it is cloudy in Oslo.');

    const result = await runAgent(client(), 'Order A-1001 status and Oslo weather?');
    expect(result.toolCalls.map((c) => c.name)).toEqual(['lookup_order', 'get_weather']);
    expect(mock).toHaveToolTrajectory(['lookup_order', 'get_weather']);
    expect(lastToolResults()).toHaveLength(2); // both results in ONE user message
  });

  it('reports a hallucinated tool back to the model as an error', async () => {
    mock.when({}).reply(edge.hallucinatedTool('delete_all_orders')).then.reply('Sorry, I cannot do that.');

    const result = await runAgent(client(), 'Clean up my orders');
    expect(result.toolCalls[0]).toMatchObject({ name: 'delete_all_orders', ok: false });
    expect(mock).toHaveRequestedTool('delete_all_orders');
    expect(mock).toHaveReturnedToolResult('delete_all_orders', /Unknown tool/);
    expect(lastToolResults()[0]).toMatchObject({ isError: true });
    expect(result.answer).toBe('Sorry, I cannot do that.');
  });

  it('rejects tool input of the wrong type', async () => {
    mock.when({}).reply(edge.wrongToolArgTypes('lookup_order', { order_id: 1001 })).then.reply('Which order did you mean?');

    const result = await runAgent(client(), 'Where is my order?');
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(lastToolResults()[0]).toMatchObject({ isError: true });
  });

  it('stops a runaway loop after maxTurns', async () => {
    mock.when({}).replyToolCall('get_weather', { city: 'Paris' }); // the last step repeats forever

    await expect(runAgent(client(), 'Weather?', { maxTurns: 3 })).rejects.toBeInstanceOf(AgentError);
    expect(mock).toHaveReceivedRequestTimes(3);
  });

  it('surfaces refusals instead of returning an empty answer', async () => {
    mock.when({}).reply(edge.refusal());
    await expect(runAgent(client(), 'Something disallowed')).rejects.toThrow(/declined/);
  });

  it('routes on model family and toolset (glob + tools matchers)', async () => {
    // One rule for any Claude model that offers both tools; anything else falls through.
    mock.default().reply('generic');
    mock.when({ model: 'claude-*', tools: ['lookup_order', 'get_weather'] }).reply('Claude shopping agent');

    expect((await runAgent(client(), 'hi')).answer).toBe('Claude shopping agent');
    expect((await runAgent(client(), 'hi', { model: 'claude-haiku-4-5' })).answer).toBe('Claude shopping agent');
    expect((await runAgent(client(), 'hi', { tools: {} })).answer).toBe('generic'); // no tools offered
  });

  it('sends every tool definition with each request', async () => {
    mock.when({}).reply('Hi!');
    await runAgent(client(), 'Hello');
    expect(mock).toHaveReceivedRequest({ tools: ['lookup_order', 'get_weather'] });
  });
});
