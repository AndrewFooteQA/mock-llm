import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseCommand, type Message } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI, type Content } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { MockLLM } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

// The same 2-tool agent loop through every official SDK, then the R2 matchers on the
// journal. Proves tool ids / history line up per provider (incl. Gemini's id-less
// function calls and the Responses API's previous_response_id).

const mock = useMockLLM();
const SYSTEM = 'You are a shopping assistant.';
const schema = { type: 'object', properties: { q: { type: 'string' }, id: { type: 'string' } } };
const runTool = (name: string, args: any) => (name === 'search' ? { results: [{ id: 'p2' }] } : { id: args.id, inStock: true });

type Agent = (m: MockLLM) => Promise<string>;

const agents: Record<string, Agent> = {
  openai: async (m) => {
    const c = new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 });
    const tools = ['search', 'get_product'].map((name) => ({ type: 'function' as const, function: { name, parameters: schema } }));
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Find a laptop' }];
    for (;;) {
      const msg = (await c.chat.completions.create({ model: 'gpt-4o', messages, tools })).choices[0]!.message;
      messages.push(msg);
      if (!msg.tool_calls?.length) return msg.content ?? '';
      for (const t of msg.tool_calls as OpenAI.ChatCompletionMessageFunctionToolCall[]) {
        messages.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify(runTool(t.function.name, JSON.parse(t.function.arguments))) });
      }
    }
  },
  'openai-responses': async (m) => {
    const c = new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 });
    const tools = ['search', 'get_product'].map((name) => ({ type: 'function' as const, name, parameters: schema, strict: false }));
    let r = await c.responses.create({ model: 'gpt-4.1', instructions: SYSTEM, input: 'Find a laptop', tools });
    for (;;) {
      const calls = r.output.filter((o) => o.type === 'function_call') as OpenAI.Responses.ResponseFunctionToolCall[];
      if (!calls.length) return r.output_text;
      r = await c.responses.create({
        model: 'gpt-4.1',
        instructions: SYSTEM,
        previous_response_id: r.id,
        tools,
        input: calls.map((x) => ({ type: 'function_call_output' as const, call_id: x.call_id, output: JSON.stringify(runTool(x.name, JSON.parse(x.arguments))) })),
      });
    }
  },
  anthropic: async (m) => {
    const c = new Anthropic({ baseURL: m.urls.anthropic, apiKey: 'k', maxRetries: 0 });
    const tools = ['search', 'get_product'].map((name) => ({ name, input_schema: schema as Anthropic.Tool.InputSchema }));
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Find a laptop' }];
    for (;;) {
      const msg = await c.messages.create({ model: 'claude-opus-5-5', max_tokens: 512, system: SYSTEM, messages, tools });
      if (msg.stop_reason !== 'tool_use') return msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({
        role: 'user',
        content: msg.content.flatMap((b) => (b.type === 'tool_use' ? [{ type: 'tool_result' as const, tool_use_id: b.id, content: JSON.stringify(runTool(b.name, b.input)) }] : [])),
      });
    }
  },
  gemini: async (m) => {
    const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { baseUrl: m.urls.gemini } });
    const config = { systemInstruction: SYSTEM, tools: [{ functionDeclarations: ['search', 'get_product'].map((name) => ({ name, parametersJsonSchema: schema })) }] };
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'Find a laptop' }] }];
    for (;;) {
      const r = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents, config });
      const calls = r.functionCalls ?? [];
      if (!calls.length) return r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      contents.push(r.candidates![0]!.content!);
      contents.push({ role: 'user', parts: calls.map((fc) => ({ functionResponse: { name: fc.name, response: runTool(fc.name!, fc.args) } })) });
    }
  },
  bedrock: async (m) => {
    const c = new BedrockRuntimeClient({ endpoint: m.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, maxAttempts: 1 });
    const toolConfig = { tools: ['search', 'get_product'].map((name) => ({ toolSpec: { name, inputSchema: { json: schema } } })) } as any;
    const messages: Message[] = [{ role: 'user', content: [{ text: 'Find a laptop' }] }];
    for (;;) {
      const r = await c.send(new ConverseCommand({ modelId: 'anthropic.claude-sonnet-5-5', system: [{ text: SYSTEM }], messages, toolConfig }));
      const content = r.output!.message!.content!;
      if (r.stopReason !== 'tool_use') return content.map((b) => b.text ?? '').join('');
      messages.push(r.output!.message!);
      messages.push({
        role: 'user',
        content: content.flatMap((b) => (b.toolUse ? [{ toolResult: { toolUseId: b.toolUse.toolUseId, content: [{ json: runTool(b.toolUse.name!, b.toolUse.input) }] } }] : [])) as unknown as Message['content'],
      });
    }
  },
};

describe.each(Object.keys(agents))('matchers through the %s SDK', (provider) => {
  it('assert the agent trajectory, tool results, prompts and budget', async () => {
    mock
      .when({ tool: 'search' })
      .replyToolCall('search', { q: 'laptop' })
      .then.replyToolCall('get_product', { id: 'p2' })
      .then.reply('The p2 laptop is in stock.');

    expect(await agents[provider]!(mock)).toBe('The p2 laptop is in stock.');

    expect(mock).toHaveReceivedRequestTimes(3);
    expect(mock).toHaveReceivedRequest({ system: SYSTEM, tools: ['search', 'get_product'] });
    expect(mock).toHaveReceivedPrompt('Find a laptop', { in: 'user' });
    expect(mock).toHaveOfferedTool('get_product');
    expect(mock).not.toHaveOfferedTool('purchase');
    expect(mock).toHaveRequestedTool('get_product', { id: 'p2' });
    expect(mock).toHaveReturnedToolResult('search', { results: [{ id: 'p2' }] });
    expect(mock).toHaveReturnedToolResult('get_product', { inStock: true });
    expect(mock).toHaveToolTrajectory(['search', 'get_product']);
    expect(mock).toHaveToolTrajectory([{ name: 'get_product', args: { id: 'p2' } }], { mode: 'subsequence' });
    expect(mock).toHaveUsedTokensLessThan(5_000);
  });
});

describe('budget assertions on priced models', () => {
  it('toCostLessThan works for Claude out of the box', async () => {
    mock.when({}).reply('ok', { usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    await agents.anthropic!(mock);
    expect(mock).toCostLessThan(4.01); // claude-opus-5-5: $4 / 1M input tokens
    expect(mock).not.toCostLessThan(3.99);
  });
});
