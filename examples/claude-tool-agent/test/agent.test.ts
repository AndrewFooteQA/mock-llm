import Anthropic from '@anthropic-ai/sdk';
import { edge, type JournalEntry, type ReplyOptions } from 'mock-llm';
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

  it('streams every turn, including a tool-use turn, and the final answer text as it arrives', async () => {
    mock.when({ tool: 'lookup_order' }).replyToolCall('lookup_order', { order_id: 'A-1001' }, { text: 'Let me check.' });
    mock.when({ hasToolResult: true }).reply('Your order has shipped and arrives on Thursday.');

    const deltas: string[] = [];
    const result = await runAgent(client(), 'Where is order A-1001?', { stream: true, onText: (d) => deltas.push(d) });

    // The tool call was reassembled from streamed input_json deltas by the SDK's stream helper.
    expect(result.toolCalls).toEqual([{ name: 'lookup_order', input: { order_id: 'A-1001' }, ok: true }]);
    expect(result.answer).toBe('Your order has shipped and arrives on Thursday.');
    // onText saw both turns' text, in order, in more than one piece.
    expect(deltas.join('')).toBe('Let me check.Your order has shipped and arrives on Thursday.');
    expect(deltas.length).toBeGreaterThan(2);
    const turns: JournalEntry[] = mock.journal.all();
    expect(turns.map((e) => e.request.stream)).toEqual([true, true]);
    expect(mock).toHaveReturnedToolResult('lookup_order', { status: 'shipped' });
  });

  it('keeps the model\'s reasoning out of the answer, but logs it', async () => {
    const withReasoning: ReplyOptions = { thinking: 'The user wants order status; no tool needed for a greeting.' };
    mock.when({}).reply('Hello! How can I help?', withReasoning);

    for (const stream of [false, true]) {
      const logged: string[] = [];
      const result = await runAgent(client(), 'Hi', { stream, log: (l) => logged.push(l) });
      expect(result.answer).toBe('Hello! How can I help?');
      expect(result.answer).not.toContain('order status');
      expect(logged).toEqual([`thinking: ${withReasoning.thinking}`]);
    }
    // The provider-native request body is on `request.raw`: the agent asked for adaptive thinking every time.
    expect(mock.journal.all().map((e) => e.request.raw.thinking)).toEqual([{ type: 'adaptive' }, { type: 'adaptive' }]);
  });

  it('sends every tool definition with each request', async () => {
    mock.when({}).reply('Hi!');
    await runAgent(client(), 'Hello');
    expect(mock).toHaveReceivedRequest({ tools: ['lookup_order', 'get_weather'] });
    expect(mock).toHaveOfferedTool('lookup_order');
    expect(mock).not.toHaveOfferedTool('delete_all_orders');
  });

  it('runs any schema-valid tool input the model might produce', async () => {
    // Input generated from the tool's own input_schema, as the request offered it.
    mock.when({ hasToolResult: false }).replyToolCallFromSchema('lookup_order');
    mock.when({ hasToolResult: true }).reply('Done.');
    const result = await runAgent(client(), 'Check an order');
    expect(result.toolCalls).toEqual([{ name: 'lookup_order', input: { order_id: expect.any(String) }, ok: true }]);
  });

  it('reports malformed tool arguments back to the model instead of crashing', async () => {
    mock.when({}).reply(edge.malformedToolArgs('lookup_order')).then.reply('Could you give me the order number again?');
    const result = await runAgent(client(), 'Where is my order?');
    expect(result.toolCalls[0]).toMatchObject({ name: 'lookup_order', ok: false });
    expect(lastToolResults()[0]).toMatchObject({ isError: true });
    expect(result.answer).toBe('Could you give me the order number again?');
  });

  it('routes on the shape of the conversation (system, turn, tools, streaming, any message, custom predicate)', async () => {
    mock.default().reply('fallback');
    mock.when({ system: /shopping assistant/, hasTools: true, turn: 1 }).reply('first turn of a shopping chat');
    mock.when({ anyMessage: /gift wrap/i }).reply('We offer gift wrap for £2.');
    mock.when({ stream: true, hasTools: true }).reply('streamed shopping answer');
    mock.when({ where: (req) => req.messages.length > 0 && req.model.endsWith('-haiku-4-5') }).reply('quick answer from Haiku');

    expect((await runAgent(client(), 'hi')).answer).toBe('first turn of a shopping chat');
    expect((await runAgent(client(), 'Do you do gift wrap?')).answer).toBe('We offer gift wrap for £2.');
    expect((await runAgent(client(), 'hi', { stream: true })).answer).toBe('streamed shopping answer');
    expect((await runAgent(client(), 'hi', { model: 'claude-haiku-4-5' })).answer).toBe('quick answer from Haiku');
    expect((await runAgent(client(), 'hi', { tools: {} })).answer).toBe('fallback'); // no tools: only the default matches
  });
});
