import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { edge, faults } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM({ seed: 7 });
const client = () => new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 0 });
const MODEL = 'gpt-4.1';
const weather: OpenAI.Responses.FunctionTool = {
  type: 'function',
  name: 'get_weather',
  strict: true,
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};

describe('openai: Responses API', () => {
  it('text reply with output_text helper', async () => {
    mock.when({ lastUserMessage: 'hello' }).reply('Hi via Responses');
    const r = await client().responses.create({ model: MODEL, instructions: 'Be terse.', input: 'hello' });
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
    expect(r.output_text).toBe('Hi via Responses');
    expect(r.usage!.total_tokens).toBeGreaterThan(0);
    expect(mock.journal.last()!.request.system).toBe('Be terse.');
  });

  it('function calls + previous_response_id continuation', async () => {
    mock.when({ tool: 'get_weather' }).replyToolCall('get_weather', { city: 'Paris' });
    mock.when({ hasToolResult: true }).replyTemplate('Sunny ({{lastUserMessage}})');
    const first = await client().responses.create({ model: MODEL, input: 'Weather?', tools: [weather] });
    const call = first.output.find((o) => o.type === 'function_call') as OpenAI.Responses.ResponseFunctionToolCall;
    expect(JSON.parse(call.arguments)).toEqual({ city: 'Paris' });

    const second = await client().responses.create({
      model: MODEL,
      previous_response_id: first.id,
      tools: [weather],
      input: [{ type: 'function_call_output', call_id: call.call_id, output: '{"temp":21}' }],
    });
    expect(second.output_text).toContain('Sunny');
    // The mock reconstructed the whole conversation from the stored response.
    const sent = mock.journal.last()!.request.messages;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('unknown previous_response_id is a 400', async () => {
    await expect(client().responses.create({ model: MODEL, previous_response_id: 'resp_nope', input: 'x' })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });

  it('streams via the SDK ResponseStream helper', async () => {
    mock.when({}).reply('streaming works', { thinking: 'considering' });
    const stream = client().responses.stream({ model: MODEL, input: 'x' });
    const deltas: string[] = [];
    stream.on('response.output_text.delta', (e) => deltas.push(e.delta));
    const final = await stream.finalResponse();
    expect(deltas.join('')).toBe('streaming works');
    expect(final.output_text).toBe('streaming works');
    expect(final.output[0]!.type).toBe('reasoning');
  });

  it('streams function call arguments', async () => {
    mock.when({}).replyToolCall('get_weather', { city: 'Oslo' });
    const final = await client().responses.stream({ model: MODEL, input: 'x', tools: [weather] }).finalResponse();
    const call = final.output.find((o) => o.type === 'function_call') as OpenAI.Responses.ResponseFunctionToolCall;
    expect(JSON.parse(call.arguments)).toEqual({ city: 'Oslo' });
  });

  it('structured output from text.format json_schema', async () => {
    mock.when({ responseFormat: 'json_schema' }).replyFromSchema();
    const r = await client().responses.create({
      model: MODEL,
      input: 'person',
      text: {
        format: {
          type: 'json_schema',
          name: 'person',
          schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0, maximum: 120 } }, required: ['name', 'age'] },
        },
      },
    });
    const v = JSON.parse(r.output_text);
    expect(typeof v.name).toBe('string');
    expect(v.age).toBeGreaterThanOrEqual(0);
  });

  it('refusal, truncation and in-stream errors', async () => {
    mock.when('refuse').reply(edge.refusal('Nope.'));
    mock.when('long').reply(edge.truncated('cut off here'));
    mock.when('err').fail(faults.streamError({ afterChunks: 4 }));
    const refused = await client().responses.create({ model: MODEL, input: 'refuse' });
    expect((refused.output[0] as any).content[0]).toEqual({ type: 'refusal', refusal: 'Nope.' });
    const long = await client().responses.create({ model: MODEL, input: 'long' });
    expect(long.status).toBe('incomplete');
    expect(long.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    await expect(client().responses.stream({ model: MODEL, input: 'err' }).finalResponse()).rejects.toBeInstanceOf(OpenAI.APIError);
  });
});
