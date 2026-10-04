import { describe, expect, it, vi } from 'vitest';
import { Journal, type JournalEntry } from '../../src/core/journal.js';
import { DEFAULT_PRICING } from '../../src/core/pricing.js';
import type { IRMessage, IRRequest, IRResponse } from '../../src/core/types.js';
import {
  toCostLessThan,
  toHaveOfferedTool,
  toHaveReceivedPrompt,
  toHaveReceivedRequest,
  toHaveReceivedRequestTimes,
  toHaveRequestedTool,
  toHaveReturnedToolResult,
  toHaveToolTrajectory,
  toHaveUsedTokensLessThan,
} from '../../src/assert/index.js';
import '../../src/testing/vitest.js'; // registers the matchers

let nextId = 1;
function entry(req: Partial<IRRequest>, response?: IRResponse, extra: Partial<JournalEntry> = {}): JournalEntry {
  const request: IRRequest = {
    provider: 'anthropic',
    endpoint: 'chat',
    path: '/v1/messages',
    model: 'claude-opus-5-5',
    messages: [],
    tools: [],
    stream: false,
    headers: {},
    raw: {},
    ...req,
  };
  return {
    id: nextId++,
    provider: request.provider,
    endpoint: request.endpoint,
    method: 'POST',
    path: request.path,
    request,
    response,
    status: 200,
    startedAt: 0,
    usage: { inputTokens: 1000, outputTokens: 200 },
    ...extra,
  };
}

const user = (text: string): IRMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const tools = [{ name: 'search' }, { name: 'get_product' }, { name: 'purchase' }];

/** A 3-turn shopping agent: search → get_product, then a final answer. */
function shoppingJournal(): Journal {
  const j = new Journal(DEFAULT_PRICING);
  const turn1: IRMessage[] = [user('Find me a laptop')];
  j.add(
    entry(
      { system: 'You are a shopping assistant', messages: turn1, tools },
      { content: [{ type: 'tool_call', id: 't1', name: 'search', input: { q: 'laptop' } }] },
    ),
  );
  const turn2: IRMessage[] = [
    ...turn1,
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'search', input: { q: 'laptop' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: '{"results":[{"id":"p2","price":999}]}' }] },
  ];
  j.add(entry({ system: 'You are a shopping assistant', messages: turn2, tools }, { content: [{ type: 'tool_call', id: 't2', name: 'get_product', input: { id: 'p2' } }] }));
  const turn3: IRMessage[] = [
    ...turn2,
    { role: 'assistant', content: [{ type: 'tool_call', id: 't2', name: 'get_product', input: { id: 'p2' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', content: '{"id":"p2","inStock":true}' }] },
  ];
  j.add(entry({ system: 'You are a shopping assistant', messages: turn3, tools }, { content: [{ type: 'text', text: 'The p2 laptop is in stock.' }] }));
  j.add(entry({ endpoint: 'count_tokens', messages: turn1 })); // never counted by default
  return j;
}

describe('toHaveReceivedRequest', () => {
  it('passes for any chat request, or one matching partially', () => {
    const j = shoppingJournal();
    expect(toHaveReceivedRequest(j).pass).toBe(true);
    expect(toHaveReceivedRequest(j, { model: 'claude-opus-5-5', tools: ['search', 'get_product', 'purchase'] }).pass).toBe(true);
    expect(toHaveReceivedRequest(j, { system: /shopping/, lastUserMessage: expect.stringContaining('laptop') }).pass).toBe(true);
  });
  it('fails with a readable excerpt', () => {
    const r = toHaveReceivedRequest(shoppingJournal(), { model: 'gpt-4o' });
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('Expected mock-llm to have received a request matching {"model":"gpt-4o"}');
    expect(r.message()).toMatch(/#\d+ anthropic chat claude-opus-5-5 \[200\]/);
    expect(r.message()).toContain('tools offered: search, get_product, purchase');
  });
  it('fails on an empty journal', () => {
    expect(toHaveReceivedRequest(new Journal()).message()).toContain('Requests received: none');
  });
});

describe('toHaveReceivedRequestTimes', () => {
  it('counts chat requests only, with filters', () => {
    const j = shoppingJournal();
    expect(toHaveReceivedRequestTimes(j, 3).pass).toBe(true);
    expect(toHaveReceivedRequestTimes(j, 4, { endpoint: 'any' }).pass).toBe(true);
    expect(toHaveReceivedRequestTimes(j, 0, { provider: 'openai' }).pass).toBe(true);
  });
  it('fails with the actual count', () => {
    const r = toHaveReceivedRequestTimes(shoppingJournal(), 2);
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('to have received 2 request(s), received 3');
  });
});

describe('toHaveReceivedPrompt', () => {
  it('matches system and user text by substring, RegExp or asymmetric matcher', () => {
    const j = shoppingJournal();
    expect(toHaveReceivedPrompt(j, 'shopping assistant').pass).toBe(true);
    expect(toHaveReceivedPrompt(j, /find me a LAPTOP/i, { in: 'user' }).pass).toBe(true);
    expect(toHaveReceivedPrompt(j, expect.stringMatching(/^Find/), { in: 'lastUser' }).pass).toBe(true);
    expect(toHaveReceivedPrompt(j, 'laptop', { in: 'system' }).pass).toBe(false);
  });
  it('fails naming where it looked', () => {
    const r = toHaveReceivedPrompt(shoppingJournal(), 'refund');
    expect(r.message()).toContain('to have received a prompt (any) matching "refund"');
  });
});

describe('tool matchers', () => {
  it('toHaveOfferedTool', () => {
    expect(toHaveOfferedTool(shoppingJournal(), 'purchase').pass).toBe(true);
    const r = toHaveOfferedTool(shoppingJournal(), 'refund');
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('tools offered: ["search","get_product","purchase"]');
  });

  it('toHaveRequestedTool (mock → app), with partial args', () => {
    const j = shoppingJournal();
    expect(toHaveRequestedTool(j, 'search').pass).toBe(true);
    expect(toHaveRequestedTool(j, 'get_product', { id: 'p2' }).pass).toBe(true);
    const r = toHaveRequestedTool(j, 'get_product', { id: 'p9' });
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('requested: [{"name":"search","args":{"q":"laptop"}},{"name":"get_product","args":{"id":"p2"}}]');
    // offered but never requested:
    expect(toHaveRequestedTool(j, 'purchase').pass).toBe(false);
  });

  it('toHaveReturnedToolResult (app → mock): text, RegExp, or partial JSON', () => {
    const j = shoppingJournal();
    expect(toHaveReturnedToolResult(j, 'search').pass).toBe(true);
    expect(toHaveReturnedToolResult(j, 'search', /p2/).pass).toBe(true);
    expect(toHaveReturnedToolResult(j, 'get_product', { inStock: true }).pass).toBe(true);
    const r = toHaveReturnedToolResult(j, 'get_product', { inStock: false });
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('results returned:');
    expect(r.message()).toContain('tool results sent: get_product→{"id":"p2","inStock":true}');
  });

  it('does not double count results repeated in history', () => {
    const j = shoppingJournal();
    const r = toHaveToolTrajectory(j, ['search', 'get_product']);
    expect(r.pass).toBe(true);
    expect(r.actual).toEqual([
      { name: 'search', args: { q: 'laptop' } },
      { name: 'get_product', args: { id: 'p2' } },
    ]);
  });

  it('toHaveToolTrajectory exact vs subsequence, returned vs requested, with args', () => {
    const j = shoppingJournal();
    expect(toHaveToolTrajectory(j, ['get_product']).pass).toBe(false); // exact
    expect(toHaveToolTrajectory(j, ['get_product'], { mode: 'subsequence' }).pass).toBe(true);
    expect(toHaveToolTrajectory(j, [{ name: 'get_product', args: { id: 'p2' } }], { mode: 'subsequence' }).pass).toBe(true);
    expect(toHaveToolTrajectory(j, ['search', 'get_product'], { source: 'requested' }).pass).toBe(true);
    const r = toHaveToolTrajectory(j, ['search', 'purchase']);
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('to have a returned tool trajectory (exact) of search → purchase; actual: search → get_product');
  });
});

describe('budget matchers', () => {
  it('toHaveUsedTokensLessThan (total / input / output)', () => {
    const j = shoppingJournal(); // 3 chat entries × (1000 in + 200 out)
    expect(toHaveUsedTokensLessThan(j, 3601).pass).toBe(true);
    expect(toHaveUsedTokensLessThan(j, 601, { kind: 'output' }).pass).toBe(true);
    const r = toHaveUsedTokensLessThan(j, 3000, { kind: 'input' });
    expect(r.pass).toBe(false);
    expect(r.message()).toContain('fewer than 3000 input tokens, used 3000 (input 3000, output 600)');
  });

  it('toCostLessThan uses journal pricing and refuses to guess unpriced models', () => {
    const j = shoppingJournal(); // claude-opus-5-5: $4/M in, $20/M out → 3×(0.004+0.004) = $0.024
    expect(toCostLessThan(j, 0.025).pass).toBe(true);
    const tooMuch = toCostLessThan(j, 0.02);
    expect(tooMuch.pass).toBe(false);
    expect(tooMuch.message()).toContain('cost $0.024000');

    j.add(entry({ provider: 'openai', model: 'gpt-4o' }));
    const unpriced = toCostLessThan(j, 1);
    expect(unpriced.pass).toBe(false);
    expect(unpriced.message()).toContain('no price for gpt-4o');
    expect(toCostLessThan(j, 1, { allowUnpriced: true }).pass).toBe(true);
    expect(toCostLessThan(j, 0.025, { filter: { provider: 'anthropic' } }).pass).toBe(true);
  });
});

describe('vitest integration', () => {
  it('registers matchers usable on a MockLLM-like target, including .not', () => {
    const mock = { journal: shoppingJournal() };
    expect(mock).toHaveOfferedTool('search');
    expect(mock).not.toHaveOfferedTool('refund');
    expect(mock).toHaveToolTrajectory(['search', 'get_product']);
    expect(mock).toHaveReceivedRequestTimes(3);
    expect(mock).toHaveReceivedPrompt(expect.stringContaining('laptop'));
    expect(() => expect(mock).not.toHaveOfferedTool('search')).toThrow(/Expected mock-llm NOT to have offered tool "search"/);
    expect(() => expect(mock).toHaveRequestedTool('purchase')).toThrow(/Expected mock-llm to have requested tool "purchase"/);
  });

  it("does not shadow Vitest's built-in spy matchers", () => {
    const spy = vi.fn();
    spy('x');
    expect(spy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('x');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects non-mock targets clearly', () => {
    expect(() => expect(42).toHaveOfferedTool('x')).toThrow(/expect a MockLLM or its journal/);
  });

  it('is typed (checked by npm run typecheck)', () => {
    const mock = { journal: shoppingJournal() };
    // @ts-expect-error count must be a number
    expect(() => expect(mock).toHaveReceivedRequestTimes('three')).toThrow();
  });
});
