import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createMockLLM, fakeFromSchema, MockLLM } from '../../src/index.js';
import { Rng } from '../../src/core/rng.js';

const ask = (mock: MockLLM, content: string, extra: Record<string, unknown> = {}) =>
  new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    ...extra,
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);

describe('fakeFromSchema', () => {
  const schema = {
    type: 'object',
    $defs: { tag: { type: 'string', enum: ['a', 'b'] } },
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      count: { type: 'integer', minimum: 5, maximum: 9 },
      tags: { type: 'array', items: { $ref: '#/$defs/tag' }, minItems: 2, maxItems: 2 },
      nested: { anyOf: [{ type: 'null' }, { type: 'object', properties: { ok: { type: 'boolean' } } }] },
      kind: { const: 'fixed' },
    },
    required: ['id', 'email', 'count'],
  };

  it('generates conforming, deterministic values', () => {
    const v = fakeFromSchema(schema, new Rng(3)) as any;
    expect(v.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(v.email).toMatch(/@example\.com$/);
    expect(v.count).toBeGreaterThanOrEqual(5);
    expect(v.count).toBeLessThanOrEqual(9);
    expect(v.tags).toHaveLength(2);
    expect(['a', 'b']).toContain(v.tags[0]);
    expect(typeof v.nested.ok).toBe('boolean');
    expect(v.kind).toBe('fixed');
    expect(fakeFromSchema(schema, new Rng(3))).toEqual(v);
  });

  it('violate drops a required field', () => {
    const v = fakeFromSchema(schema, new Rng(3), { violate: true }) as any;
    expect(v.id).toBeUndefined();
  });

  it('handles Gemini-style uppercase types', () => {
    const v = fakeFromSchema({ type: 'OBJECT', properties: { n: { type: 'NUMBER' } } }, new Rng(1)) as any;
    expect(typeof v.n).toBe('number');
  });
});

describe('schema-driven responders', () => {
  it('replyToolCallFromSchema fills tool args from the offered schema', async () => {
    const mock = await createMockLLM();
    try {
      mock.when({}).replyToolCallFromSchema('lookup');
      const r = await ask(mock, 'x', {
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } } } } }],
      });
      const args = JSON.parse((r.choices[0]!.message.tool_calls![0] as any).function.arguments);
      expect(typeof args.sku).toBe('string');
      expect(Number.isInteger(args.qty)).toBe(true);
    } finally {
      await mock.stop();
    }
  });
});

describe('scenario files', () => {
  it('loads YAML: rules, sequences, faults, edge cases, inject, scenarios, default', async () => {
    const mock = await createMockLLM({ scenarioFiles: ['tests/fixtures/support-bot.yaml'] });
    try {
      expect((await ask(mock, 'I want a REFUND')).choices[0]!.message.content).toBe('Refunds take 5 business days.');
      expect((await ask(mock, 'hello')).choices[0]!.message.content).toBe('Sorry, I can only help with refunds.');
      expect((await ask(mock, 'hi [[mock:vip]]')).choices[0]!.message.content).toBe('Welcome back, VIP! You said: hi [[mock:vip]]');
      expect((await ask(mock, 'weird')).choices[0]!.message.content).toMatch(/👩🏽‍💻.*\[INJECTED\]$/s);

      await expect(ask(mock, 'flaky')).rejects.toBeInstanceOf(OpenAI.RateLimitError);
      expect((await ask(mock, 'flaky')).choices[0]!.message.content).toContain('Sorry'); // once → falls through

      const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
      expect((await ask(mock, 'w', { tools })).choices[0]!.message.tool_calls![0]).toMatchObject({ function: { name: 'get_weather' } });
      expect((await ask(mock, 'w', { tools })).choices[0]!.message.content).toBe('It is sunny in Paris.');
    } finally {
      await mock.stop();
    }
  });

  it('validates files with helpful errors', async () => {
    const mock = new MockLLM();
    await expect(mock.load({ rules: [{ when: { lastUserMesage: 'x' }, reply: 'y' }] } as any)).rejects.toThrow(/unknown matcher 'lastUserMesage'/);
    await expect(mock.load({ rules: [{ reply: 'a', json: {} }] })).rejects.toThrow(/exactly one of/);
    await expect(mock.load({ rules: [{ fail: 'tooManyCats' }] })).rejects.toThrow(/unknown fault 'tooManyCats'/);
  });
});

describe('cost simulation', () => {
  it('prices Claude models by default and reports unpriced models', async () => {
    const mock = await createMockLLM({ pricing: { 'gpt-4o': { input: 2.5, output: 10 } } });
    try {
      mock.when({}).reply({ content: [{ type: 'text', text: 'x' }], usage: { inputTokens: 1_000_000, outputTokens: 100_000 } });
      await fetch(`${mock.urls.anthropic}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
      });
      await fetch(`${mock.urls.bedrock}/model/us.anthropic.claude-sonnet-5-5/converse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'x' }] }] }),
      });
      await ask(mock, 'x');
      await ask(mock, 'x', { model: 'some-unpriced-model' });
      const cost = mock.journal.cost();
      expect(cost.byModel['claude-opus-5-5']!.usd).toBeCloseTo(4 + 2, 6); // $4/M in + $20/M × 0.1M out
      expect(cost.byModel['us.anthropic.claude-sonnet-5-5']!.usd).toBeCloseTo(2 + 1, 6);
      expect(cost.byModel['gpt-4o']!.usd).toBeCloseTo(2.5 + 1, 6);
      expect(cost.unpriced).toEqual(['some-unpriced-model']);
      expect(cost.total).toBeCloseTo(12.5, 6);
    } finally {
      await mock.stop();
    }
  });
});

describe('wire recording', () => {
  it('records the raw request and response, decoding Bedrock event-stream frames', async () => {
    const mock = await createMockLLM();
    try {
      mock.when({}).reply('hi there');
      await ask(mock, 'x');
      const wire = mock.journal.last()!.wire!;
      expect(wire.request).toMatchObject({ method: 'POST', url: '/openai/v1/chat/completions' });
      expect(JSON.parse(wire.request.body).messages[0].content).toBe('x');
      expect(wire.response.status).toBe(200);
      expect(JSON.parse(wire.response.body).choices[0].message.content).toBe('hi there');

      const { BedrockRuntimeClient, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = new BedrockRuntimeClient({ endpoint: mock.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
      const r = await client.send(new ConverseStreamCommand({ modelId: 'anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text: 'x' }] }] }));
      for await (const _ of r.stream!);
      expect(mock.journal.last()!.wire!.response.body).toContain('[event-stream frame');
      expect(mock.journal.last()!.wire!.response.body).toContain('event:messageStop');
    } finally {
      await mock.stop();
    }
  });
});
