import { describe, expect, it } from '@jest/globals';
import { edge, faults } from 'mock-llm';
import { useMockLLM } from 'mock-llm/jest';
import OpenAI from 'openai';
import { INSTRUCTIONS, TravelAssistant } from '../src/assistant.mjs';

// strict: an LLM call a test didn't script fails that test, even though the
// assistant hides API errors from the user.
const mock = useMockLLM({ strict: true });
const assistant = (opts = {}) => new TravelAssistant(new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0, ...opts }));

describe('TravelAssistant (OpenAI Responses API, tested with Jest)', () => {
  it('uses the weather tool, then answers', async () => {
    mock.when({ tool: 'get_weather', hasToolResult: false }).replyToolCall('get_weather', { city: 'Lisbon' });
    mock.when({ hasToolResult: true }).reply('It is 19°C and cloudy in Lisbon.');

    const answer = await assistant().ask("What's the weather in Lisbon?");

    expect(answer).toEqual({ text: 'It is 19°C and cloudy in Lisbon.', toolsUsed: ['get_weather'] });
    expect(mock).toHaveReceivedRequest({ system: INSTRUCTIONS, tools: ['get_weather', 'convert_currency'] });
    expect(mock).toHaveRequestedTool('get_weather', { city: 'Lisbon' });
    expect(mock).toHaveReturnedToolResult('get_weather', { conditions: 'cloudy' });
    expect(mock).toHaveToolTrajectory(['get_weather']);
  });

  it('chains two tools in one question', async () => {
    mock
      .when({ tool: 'convert_currency' })
      .replyToolCall('get_weather', { city: 'Paris' })
      .then.replyToolCall('convert_currency', { amount: 100, from: 'EUR', to: 'USD' })
      .then.reply('Cloudy in Paris; 100 EUR is 110 USD.');

    const answer = await assistant().ask('Weather in Paris, and what is 100 EUR in USD?');

    expect(answer.toolsUsed).toEqual(['get_weather', 'convert_currency']);
    expect(mock).toHaveToolTrajectory(['get_weather', 'convert_currency']);
    expect(mock).toHaveReturnedToolResult('convert_currency', { amount: 110, currency: 'USD' });
    expect(mock).toHaveReceivedRequestTimes(3);
  });

  it('remembers the conversation through previous_response_id', async () => {
    mock.when('Lisbon').reply('Lisbon is lovely in spring.');
    mock.when('flights').replyTemplate('You asked: {{lastUserMessage}}');

    const a = assistant();
    await a.ask('Tell me about Lisbon');
    await a.ask('Any cheap flights?');

    // The second request carried the whole first exchange, reconstructed by the mock.
    const second = mock.journal.last().request;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(mock).toHaveReceivedPrompt('Tell me about Lisbon', { in: 'user' });
  });

  it('turns a refusal into a polite message', async () => {
    mock.when({}).reply(edge.refusal());
    expect(await assistant().ask('Something disallowed')).toMatchObject({ refused: true });
  });

  it('recovers from a transient 429 with SDK retries', async () => {
    mock.when({}).reply('Recovered.');
    mock.when({}).once().fail(faults.rateLimit({ retryAfter: 0.01 }));
    expect((await assistant({ maxRetries: 2 }).ask('hi')).text).toBe('Recovered.');
    expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]);
  });

  it('strict mode catches an unscripted question the assistant would hide', async () => {
    mock.when('weather').reply('Sunny.');

    // No rule for this: the assistant swallows the 400 and shows "unavailable"…
    expect(await assistant().ask('Book me a hotel')).toMatchObject({ unavailable: true });

    // …but strict mode would fail this test afterwards. Assert it explicitly here:
    expect(mock).not.toHaveNoUnmatchedRequests();
    expect(() => mock.assertNoUnmatched()).toThrow(/UNEXPECTED LLM REQUEST/);
    mock.journal.clear(); // acknowledged, so this demo test passes
  });
});
