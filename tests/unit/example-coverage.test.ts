import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockAfter, buildInventory, evaluate, exportedValues, maskStrings, stringArray, topLevelKeys } from '../../scripts/example-coverage.mjs';

describe('inventory extraction from source', () => {
  it('reads object, interface and class keys at the top level only (strings, comments and nesting ignored)', () => {
    const src = `export const faults = {
  /** a { brace in a comment */
  rateLimit: err('rate_limit', { retryAfter: 1 }),
  'stream-cut': x,
  raw(status: number, body = '{"not": "a key"}') {
    return { nested: true };
  },
  timeout,
};`;
    expect(topLevelKeys(blockAfter(src, /export const faults\s*=\s*\{/))).toEqual(['rateLimit', 'stream-cut', 'raw', 'timeout']);
    expect(maskStrings(`a('{x}') // }`)).toBe(`a('   ')     `);
  });

  it('reads interface members, and class methods (constructor included, for the caller to drop)', () => {
    expect(topLevelKeys(blockAfter('export interface O {\n  port?: number;\n  /** doc */\n  strict?: boolean;\n  cb?: (x: { a: 1 }) => void;\n}', /interface O\s*\{/))).toEqual(['port', 'strict', 'cb']);
    expect(topLevelKeys(blockAfter('class R {\n  constructor(readonly r: X) {}\n  get then(): this { return this; }\n  reply(x: string): this {\n    if (x) { return this; }\n  }\n}', /class R\s*\{/))).toEqual(['constructor', 'then', 'reply']);
  });

  it('reads value exports (not type-only ones) and string-array constants', () => {
    expect(exportedValues("export { a, b as c, type T } from './x.js';\nexport type { U } from './y.js';\nexport function f() {}\nexport const K = 1;")).toEqual(['a', 'c', 'f', 'K']);
    expect(stringArray("const ACTIONS = ['reply', 'json'] as const;", 'ACTIONS')).toEqual(['reply', 'json']);
  });

  it('reads the real library source', () => {
    const inv = buildInventory((p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
    for (const id of ['export:createMockLLM', 'fault:rateLimit', 'edge:refusal', 'scenario:rate-limit', 'matcher:toHaveToolTrajectory', 'rule:replyToolCall', 'option:strict', 'match:hasToolResult', 'step:toolCall', 'modifier:expectRequest', 'event:chunk', 'entry:mock-llm/jest', 'entry:playwright.startMockLLM']) {
      expect(inv.has(id), id).toBe(true);
    }
    expect(inv.has('rule:constructor')).toBe(false);
    expect([...inv.keys()].filter((k) => k.startsWith('export:')).some((k) => k === 'export:MockLLMOptions')).toBe(false); // type-only
  });
});

describe('evaluate (scan + gate)', () => {
  const inventory = new Map([
    ['fault:rateLimit', { area: 'fault', label: 'rateLimit', patterns: [/faults\.rateLimit\(/] }],
    ['fault:raw', { area: 'fault', label: 'raw', patterns: [/faults\.raw\(/] }],
    ['export:helper', { area: 'export', label: 'helper', patterns: [/import\s*\{[^}]*\bhelper\b[^}]*\}\s*from\s*['"]mock-llm['"]/] }],
  ]);
  const sources = {
    'bot-example': { 'test/bot.test.ts': "import { faults } from 'mock-llm';\nmock.when({}).fail(faults.rateLimit());\n// helper is mentioned in a comment only" },
    'other-example': { 'src/app.ts': 'faults.raw(502, "x")' },
  };

  it('reports covered features with the examples and files that use them', () => {
    const { rows } = evaluate(inventory, { exempt: { 'export:helper': 'internal' } }, sources);
    expect(rows.find((r) => r.id === 'fault:rateLimit')).toMatchObject({ status: 'covered', examples: ['bot-example'], files: ['test/bot.test.ts'] });
    expect(rows.find((r) => r.id === 'export:helper')).toMatchObject({ status: 'exempt', reason: 'internal' }); // a comment isn't a use
  });

  it('fails, naming the feature, when a fault loses its only example use', () => {
    const { problems } = evaluate(inventory, { exempt: { 'export:helper': 'internal' }, required: ['fault:raw'] }, { 'bot-example': sources['bot-example'] });
    expect(problems).toContain('required feature "fault:raw" is not used by any example');
    expect(problems.some((p) => p.startsWith('"fault:raw" is neither used'))).toBe(true);
  });

  it('fails on a new unused export until it is exempted with a reason', () => {
    expect(evaluate(inventory, {}, sources).problems).toEqual([expect.stringContaining('"export:helper" is neither used by an example nor exempt')]);
    expect(evaluate(inventory, { exempt: { 'export:helper': 'internal' } }, sources).problems).toEqual([]);
  });

  it('flags stale exemptions and unknown required ids', () => {
    const { problems } = evaluate(inventory, { exempt: { 'export:helper': 'x', 'fault:rateLimit': 'old', 'edge:gone': 'removed' }, required: ['sdk:nope'] }, sources);
    expect(problems).toEqual(
      expect.arrayContaining([
        'required feature "sdk:nope" is not in the inventory or the surface map',
        expect.stringContaining('exemption "edge:gone" doesn\'t match any feature'),
        expect.stringContaining('"fault:rateLimit" is exempt but an example now uses it'),
      ]),
    );
  });

  it('adds surface-map features from the config', () => {
    const { rows } = evaluate(new Map(), { surface: { 'sdk:anthropic.stream': { label: 'Anthropic messages.stream', patterns: ['messages\\.stream\\('] } } }, { a: { 'x.ts': 'client.messages.stream({})' } });
    expect(rows).toEqual([expect.objectContaining({ id: 'sdk:anthropic.stream', area: 'sdk', status: 'covered' })]);
  });
});
