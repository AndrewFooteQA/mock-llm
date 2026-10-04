import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { matchModel } from '../../src/core/rules.js';
import { toHaveReceivedRequestTimes } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM();

describe('matchModel: globs, substrings, RegExps', () => {
  it.each([
    ['claude-*', 'claude-opus-5-5', true],
    ['claude-*', 'us.anthropic.claude-sonnet-5-5', false], // globs match the whole id
    ['*claude-*', 'us.anthropic.claude-sonnet-5-5', true],
    ['*.anthropic.claude-*', 'us.anthropic.claude-sonnet-5-5', true],
    ['gpt-4?', 'gpt-4o', true],
    ['gpt-4?', 'gpt-4.1', false],
    ['gpt-4.*', 'gpt-4.1', true], // "." is literal in globs
    ['gpt-4.*', 'gpt-401', false],
    ['gemini-2.5-*', 'gemini-2.5-flash', true],
    ['claude', 'claude-opus-5-5', true], // no wildcard → substring (backwards compatible)
    ['opus', 'claude-opus-5-5', true],
    ['claude-opus-5-5', 'claude-opus-5-5', true],
  ])('%s vs %s → %s', (pattern, model, expected) => expect(matchModel(pattern, model)).toBe(expected));

  it('RegExps are tested as-is', () => {
    expect(matchModel(/^claude-(opus|sonnet)/, 'claude-sonnet-5-5')).toBe(true);
    expect(matchModel(/^claude-haiku/, 'claude-sonnet-5-5')).toBe(false);
  });
});

describe('model globs route real SDK requests across providers', () => {
  it('one rule per model family, whatever the provider id format', async () => {
    mock.when({ model: 'gpt-*' }).reply('openai family');
    mock.when({ model: '*claude-*' }).reply('claude family'); // first-party and Bedrock ids
    mock.when({ model: 'gemini-*' }).reply('gemini family');

    const openai = await new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    const claude = await new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'k' }).messages.create({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
    const gemini = await new GoogleGenAI({ apiKey: 'k', httpOptions: { baseUrl: mock.urls.gemini } }).models.generateContent({ model: 'gemini-2.5-flash', contents: 'x' });
    const bedrock = await new BedrockRuntimeClient({ endpoint: mock.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } }).send(
      new ConverseCommand({ modelId: 'us.anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text: 'x' }] }] }),
    );

    expect(openai.choices[0]!.message.content).toBe('openai family');
    expect(claude.content[0]).toMatchObject({ text: 'claude family' });
    expect(gemini.text).toBe('gemini family');
    expect(bedrock.output!.message!.content![0]!.text).toBe('claude family');
    expect(mock.journal.all().every((e) => !e.unmatched)).toBe(true);
  });

  it('assertion filters accept the same globs', async () => {
    mock.default().reply('ok');
    const c = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' });
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'o4-mini']) await c.chat.completions.create({ model, messages: [{ role: 'user', content: 'x' }] });
    expect(toHaveReceivedRequestTimes(mock, 2, { model: 'gpt-4o*' }).pass).toBe(true);
    expect(mock).toHaveReceivedRequestTimes(1, { model: 'o4-*' });
    expect(mock).toHaveReceivedRequestTimes(3, { model: '*' });
  });
});

describe('tools matcher (all listed tools offered)', () => {
  const tool = (name: string) => ({ type: 'function' as const, function: { name, parameters: { type: 'object' } } });
  const ask = (names: string[]) =>
    new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' }).chat.completions
      .create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], ...(names.length && { tools: names.map(tool) }) })
      .then((r) => r.choices[0]!.message.content);

  it('matches when every listed tool is offered, in any order, alongside others', async () => {
    mock.default().reply('fallback');
    mock.when({ tools: ['search', 'purchase'] }).reply('shopping agent');
    expect(await ask(['purchase', 'search'])).toBe('shopping agent');
    expect(await ask(['search', 'get_product', 'purchase'])).toBe('shopping agent');
    expect(await ask(['search'])).toBe('fallback');
    expect(await ask([])).toBe('fallback');
  });

  it('combines with other matchers (latest rule wins)', async () => {
    mock.when({ tools: ['search'] }).reply('search-capable');
    mock.when({ tools: ['search', 'purchase'], model: 'gpt-*' }).reply('full shopping agent');
    expect(await ask(['search', 'purchase'])).toBe('full shopping agent');
    expect(await ask(['search'])).toBe('search-capable');
  });

  it('rejects an empty or invalid tools list (with scenario locations)', async () => {
    expect(() => mock.when({ tools: [] })).toThrow(/invalid tools matcher \[\]: list at least one tool name \(use hasTools: false/);
    expect(() => mock.when({ tools: ['ok', ''] })).toThrow(/invalid tools matcher/);
    await expect(mock.load({ rules: [{ when: { tools: [] }, reply: 'x' }] })).rejects.toThrow(/^scenario: rules\[0\]\.when: invalid tools matcher/);
  });

  it('works in scenario files, together with model globs', async () => {
    await mock.load({ rules: [{ when: { model: 'gpt-4*', tools: ['search', 'purchase'] }, reply: 'from YAML' }], default: { reply: 'fallback' } });
    expect(await ask(['search', 'purchase'])).toBe('from YAML');
    expect(await ask(['search'])).toBe('fallback');
  });
});
