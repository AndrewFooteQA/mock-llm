import { describe, expect, it } from 'vitest';
import { capabilitiesOf, defaultCapabilities, normalizeModels } from '../../src/core/models.js';
import type { IRRequest, IRResponse } from '../../src/core/types.js';
import { MockLLM } from '../../src/index.js';
import { shapeAnthropicThinking } from '../../src/providers/anthropic.js';

describe('normalizeModels', () => {
  it('accepts ids and specs, keeping order', () => {
    const { ids, specs } = normalizeModels(['a', { id: 'b', lifecycle: 'retired' }]);
    expect(ids).toEqual(['a', 'b']);
    expect(specs.get('a')).toEqual({ id: 'a' });
    expect(specs.get('b')?.lifecycle).toBe('retired');
  });

  it('rejects malformed entries with a message naming the entry', () => {
    expect(() => normalizeModels([{ id: '' }])).toThrow(/invalid models entry/);
    expect(() => normalizeModels([{ id: 'x', lifecycle: 'gone' as never }])).toThrow(/"x": lifecycle must be/);
    expect(() => normalizeModels([{ id: 'x', retiresAt: 'next year' }])).toThrow(/"x": retiresAt must be an RFC 3339/);
  });

  it('the constructor validates the models option up front', () => {
    expect(() => new MockLLM({ models: [{ id: 'x', deprecatedAt: 'soon' }] })).toThrow(/deprecatedAt/);
  });
});

describe('capabilitiesOf', () => {
  it('defaults to every capability supported', () => {
    expect(capabilitiesOf(undefined)).toEqual(defaultCapabilities());
    expect(capabilitiesOf({ id: 'x' }).thinking.types.between_tools).toEqual({ supported: true });
  });

  it('merges a partial spec deeply, leaving siblings alone, and allows null where the API does', () => {
    const c = capabilitiesOf({ id: 'x', capabilities: { thinking: { types: { disabled: { supported: false } } }, effort: { xhigh: null } } });
    expect(c.thinking.types).toEqual({ adaptive: { supported: true }, between_tools: { supported: true }, disabled: { supported: false }, enabled: { supported: true } });
    expect(c.effort.xhigh).toBeNull();
    expect(c.effort.high).toEqual({ supported: true });
  });

  it('returns a fresh object each time (no shared mutation)', () => {
    const a = capabilitiesOf(undefined);
    a.batch.supported = false;
    expect(capabilitiesOf(undefined).batch.supported).toBe(true);
  });
});

describe('shapeAnthropicThinking', () => {
  const req = (type?: string) => ({ raw: type ? { thinking: { type } } : {} }) as unknown as IRRequest;
  const res = (...content: IRResponse['content']): IRResponse => ({ content });
  const T = (text: string) => ({ type: 'thinking' as const, text });
  const call = (name: string) => ({ type: 'tool_call' as const, name, input: {} });
  const text = (t: string) => ({ type: 'text' as const, text: t });
  const kinds = (r: IRResponse) => r.content.map((c) => (c.type === 'tool_call' ? `call:${c.name}` : c.type === 'thinking' ? `think:${c.text}` : 'text'));

  it('leaves the reply alone without disabled / between_tools', () => {
    const r = res(T('a'), text('x'));
    expect(shapeAnthropicThinking(req(), r)).toBe(r);
    expect(shapeAnthropicThinking(req('adaptive'), r)).toBe(r);
  });

  it('disabled drops every thinking block', () => {
    expect(kinds(shapeAnthropicThinking(req('disabled'), res(T('a'), text('x'), T('b'), call('f'))))).toEqual(['text', 'call:f']);
  });

  it('between_tools keeps at most one update per tool call, moved directly before it', () => {
    const r = res(T('first'), T('second'), text('x'), call('f'), call('g'), T('third'), call('h'), T('trailing'));
    expect(kinds(shapeAnthropicThinking(req('between_tools'), r))).toEqual(['text', 'think:second', 'call:f', 'call:g', 'think:third', 'call:h']);
  });
});

describe('speed matcher in scenario files', () => {
  it('accepts standard / fast and rejects anything else', async () => {
    const mock = new MockLLM();
    await mock.load({ rules: [{ when: { speed: 'fast' }, reply: 'fast' }] });
    await expect(mock.load({ rules: [{ when: { speed: 'turbo' }, reply: 'x' }] })).rejects.toThrow(/when\.speed: expected 'standard' or 'fast', got "turbo"/);
  });
});
