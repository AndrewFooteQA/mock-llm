import type { CostReport, JournalEntry } from '../core/journal.js';
import { lastUserText, matchModel, regexTest } from '../core/rules.js';
import type { Endpoint, IRMessage, IRRequest, Provider } from '../core/types.js';

/**
 * Framework-agnostic assertions over what an app *sent* to mock-llm.
 *
 * Every function takes a target (a MockLLM, its Journal, or anything exposing
 * `all()`), returns `{ pass, message, expected, actual }` and never throws on a
 * mismatch, so any test framework can wrap it (see `mock-llm/vitest`).
 *
 * Expected values match like `toMatchObject`: objects partially, RegExps against
 * strings, and asymmetric matchers (`expect.stringContaining(...)`) are honoured.
 */

export interface JournalLike {
  all(): JournalEntry[];
  /** The mock's effective seed, when known (for reproduction hints). */
  seed?: number;
  cost?(filter?: (e: JournalEntry) => boolean): CostReport;
}
export type AssertTarget = JournalLike | { journal: JournalLike };

export interface EntryFilter {
  provider?: Provider | Provider[];
  /** Glob (`'claude-*'`), substring, or RegExp, as in rule matchers. */
  model?: string | RegExp;
  /** Defaults to `'chat'`. Use `'any'` to include models / count_tokens / embeddings requests. */
  endpoint?: Endpoint | 'any';
}

export interface AssertionResult {
  pass: boolean;
  /** Phrased for the outcome: on `pass` it explains a negated (`.not`) failure. */
  message: () => string;
  expected?: unknown;
  actual?: unknown;
}

export type TextExpectation = string | RegExp | AsymmetricMatcher;
interface AsymmetricMatcher {
  asymmetricMatch(other: unknown): boolean;
}

/** The request as matchers see it, for `toHaveReceivedRequest({...})`. */
export interface RequestView {
  provider: Provider;
  endpoint: Endpoint;
  model: string;
  system?: string;
  lastUserMessage: string;
  messages: IRMessage[];
  /** Names of the tools offered. */
  tools: string[];
  toolChoice?: unknown;
  responseFormat?: IRRequest['responseFormat'];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  headers: Record<string, string>;
}

export type RequestExpectation = { [K in keyof RequestView]?: unknown };

export interface ToolStep {
  name: string;
  /** Matched partially against the tool call's arguments. */
  args?: unknown;
}

// ---------------------------------------------------------------- matchers

/** At least one request was received; with `expected`, at least one matches it. */
export function toHaveReceivedRequest(target: AssertTarget, expected: RequestExpectation = {}): AssertionResult {
  const { endpoint, ...rest } = expected as RequestExpectation & { endpoint?: Endpoint | 'any' };
  const entries = select(target, { endpoint: (endpoint as Endpoint | 'any' | undefined) ?? 'chat' });
  const pass = entries.some((e) => matchValue(rest, view(e.request)));
  const what = Object.keys(expected).length ? `a request matching ${fmt(expected)}` : 'a request';
  return result(pass, `to have received ${what}`, entries, expected, entries.map((e) => view(e.request)));
}

/** Exactly `count` requests were received (chat by default). */
export function toHaveReceivedRequestTimes(target: AssertTarget, count: number, filter: EntryFilter = {}): AssertionResult {
  const entries = select(target, filter);
  return result(entries.length === count, `to have received ${count} request(s)${describeFilter(filter)}, received ${entries.length}`, entries, count, entries.length);
}

/** Some request's system prompt or user message text matches. */
export function toHaveReceivedPrompt(
  target: AssertTarget,
  expected: TextExpectation,
  opts: { in?: 'any' | 'system' | 'user' | 'lastUser'; filter?: EntryFilter } = {},
): AssertionResult {
  const where = opts.in ?? 'any';
  const entries = select(target, opts.filter);
  const texts = entries.flatMap((e) => promptTexts(e.request, where));
  const pass = texts.some((t) => matchText(expected, t));
  return result(pass, `to have received a prompt (${where}) matching ${fmt(expected)}`, entries, expected, texts);
}

/** Some request offered a tool with this name. */
export function toHaveOfferedTool(target: AssertTarget, name: string, filter: EntryFilter = {}): AssertionResult {
  const entries = select(target, filter);
  const offered = [...new Set(entries.flatMap((e) => e.request.tools.map((t) => t.name)))];
  return result(offered.includes(name), `to have offered tool "${name}"; tools offered: ${fmt(offered)}`, entries, name, offered);
}

/** The mock asked the app to call this tool (optionally with matching arguments). */
export function toHaveRequestedTool(target: AssertTarget, name: string, args?: unknown, filter: EntryFilter = {}): AssertionResult {
  const entries = select(target, filter);
  const calls = requestedCalls(entries);
  const pass = calls.some((c) => c.name === name && (args === undefined || matchValue(args, c.args)));
  const what = args === undefined ? `"${name}"` : `"${name}" with ${fmt(args)}`;
  return result(pass, `to have requested tool ${what}; requested: ${fmt(calls)}`, entries, { name, args }, calls);
}

/** The app sent back a result for this tool (optionally matching its content). */
export function toHaveReturnedToolResult(
  target: AssertTarget,
  name: string,
  expected?: TextExpectation | Record<string, unknown> | unknown[],
  filter: EntryFilter = {},
): AssertionResult {
  const entries = select(target, filter);
  const results = returnedResults(entries);
  const pass = results.some((r) => r.name === name && (expected === undefined || matchResultContent(expected, r.content)));
  const what = expected === undefined ? `"${name}"` : `"${name}" matching ${fmt(expected)}`;
  return result(pass, `to have returned a tool result for ${what}; results returned: ${fmt(results)}`, entries, { name, expected }, results);
}

/**
 * The ordered tools the app ran, i.e. sent results back for (`source: 'returned'`, default),
 * or the tools the mock asked for (`source: 'requested'`). `mode: 'subsequence'`
 * allows other tools in between; `'exact'` (default) requires the same list.
 */
export function toHaveToolTrajectory(
  target: AssertTarget,
  expected: Array<string | ToolStep>,
  opts: { mode?: 'exact' | 'subsequence'; source?: 'returned' | 'requested'; filter?: EntryFilter } = {},
): AssertionResult {
  const mode = opts.mode ?? 'exact';
  const source = opts.source ?? 'returned';
  const entries = select(target, opts.filter);
  const actual: ToolStep[] = source === 'returned' ? returnedResults(entries).map(({ name, args }) => ({ name, args })) : requestedCalls(entries);
  const steps = expected.map((s) => (typeof s === 'string' ? { name: s } : s));
  const stepMatches = (s: ToolStep, a: ToolStep) => s.name === a.name && (s.args === undefined || matchValue(s.args, a.args));
  let pass: boolean;
  if (mode === 'exact') pass = steps.length === actual.length && steps.every((s, i) => stepMatches(s, actual[i]!));
  else {
    let i = 0;
    for (const a of actual) if (i < steps.length && stepMatches(steps[i]!, a)) i++;
    pass = i === steps.length;
  }
  const names = (xs: ToolStep[]) => xs.map((x) => x.name).join(' → ') || '(none)';
  return result(
    pass,
    `to have a ${source} tool trajectory (${mode}) of ${names(steps)}; actual: ${names(actual)}`,
    entries,
    steps,
    actual,
  );
}

/** Total (or input/output) simulated tokens are below `limit`. */
export function toHaveUsedTokensLessThan(
  target: AssertTarget,
  limit: number,
  opts: { kind?: 'total' | 'input' | 'output'; filter?: EntryFilter } = {},
): AssertionResult {
  const kind = opts.kind ?? 'total';
  const entries = select(target, opts.filter);
  let input = 0;
  let output = 0;
  for (const e of entries) {
    input += e.usage?.inputTokens ?? 0;
    output += e.usage?.outputTokens ?? 0;
  }
  const used = kind === 'input' ? input : kind === 'output' ? output : input + output;
  return result(used < limit, `to have used fewer than ${limit} ${kind} tokens, used ${used} (input ${input}, output ${output})`, entries, limit, used);
}

/**
 * Simulated cost (journal pricing) is below `usd`. Fails if any request used an
 * unpriced model, unless `allowUnpriced` (unpriced usage then counts as $0).
 */
export function toCostLessThan(target: AssertTarget, usd: number, opts: { filter?: EntryFilter; allowUnpriced?: boolean } = {}): AssertionResult {
  const journal = journalOf(target);
  const entries = select(target, opts.filter);
  if (!journal.cost) throw new TypeError('toCostLessThan: target journal has no cost() (pricing unavailable)');
  const ids = new Set(entries.map((e) => e.id));
  const report = journal.cost((e) => ids.has(e.id));
  const unpriced = report.unpriced.length > 0 && !opts.allowUnpriced;
  const pass = !unpriced && report.total < usd;
  const detail = unpriced
    ? `no price for ${report.unpriced.join(', ')}; pass \`pricing\` to createMockLLM or { allowUnpriced: true }`
    : `cost $${report.total.toFixed(6)}`;
  return result(pass, `to cost less than $${usd}; ${detail}`, entries, usd, report);
}

/**
 * No chat request went unmatched (no rule, scenario or default() scripted it). On failure the
 * message is the "UNEXPECTED LLM REQUEST" report with a suggested `mock.when(...)` per request.
 */
export function toHaveNoUnmatchedRequests(target: AssertTarget, filter: EntryFilter = {}): AssertionResult {
  const entries = select(target, filter);
  const unmatched = entries.filter((e) => e.unmatched);
  const seed = journalOf(target).seed;
  return {
    pass: unmatched.length === 0,
    expected: [],
    actual: unmatched.map((e) => view(e.request)),
    message: () =>
      unmatched.length
        ? unmatchedReport(unmatched, seed)
        : `Expected mock-llm to have received unmatched requests${describeFilter(filter)}, but every one of ${entries.length} request(s) matched a rule.`,
  };
}

/**
 * Every scenario expectation (`expectToolResult` / `expectRequest` on a step) was met. On failure the
 * message names each failed expectation's scenario, rule and step, with the matcher-core explanation.
 */
export function toHaveMetExpectations(target: AssertTarget, filter: EntryFilter = {}): AssertionResult {
  const entries = select(target, filter);
  const checks = entries.flatMap((e) => (e.expectations ?? []).map((x) => ({ ...x, id: e.id })));
  const failed = checks.filter((x) => !x.pass);
  return {
    pass: failed.length === 0,
    expected: [],
    actual: failed,
    message: () =>
      failed.length
        ? expectationReport(failed)
        : `Expected some scenario expectation to fail, but all ${checks.length} expectation(s) were met.`,
  };
}

/** The "SCENARIO EXPECTATION FAILED" report. */
export function expectationReport(failed: Array<{ location: string; kind: string; message: string; id: number }>): string {
  const blocks = failed.map(
    (f) => `  ${f.location}: ${f.kind} (request #${f.id})\n` + f.message.split('\n').map((l) => `      ${l}`).join('\n'),
  );
  return `SCENARIO EXPECTATION FAILED: ${failed.length} expectation(s) not met.\n\n${blocks.join('\n\n')}`;
}

/** The "UNEXPECTED LLM REQUEST" report used by strict mode. */
export function unmatchedReport(unmatched: JournalEntry[], seed?: number): string {
  const blocks = unmatched.map((e) => {
    const r = e.request;
    const last = lastUserText(r);
    const lastIsToolResult = r.messages.at(-1)?.content.some((p) => p.type === 'tool_result') ?? false;
    const when: string[] = [`provider: '${e.provider}'`];
    if (lastIsToolResult) when.push('hasToolResult: true');
    else if (last) when.push(`lastUserMessage: ${JSON.stringify(clip(last, 60))}`);
    return [
      `  #${e.id} ${e.provider} ${r.model}${r.stream ? ' (stream)' : ''}`,
      r.system ? `      system: "${clip(r.system, 80)}"` : '',
      `      last user: "${clip(last, 80)}"${lastIsToolResult ? ' (this turn carries tool results)' : ''}`,
      r.tools.length ? `      tools offered: ${r.tools.map((t) => t.name).join(', ')}` : '',
      `      add: mock.when({ ${when.join(', ')} }).reply('…');`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return (
    `UNEXPECTED LLM REQUEST: ${unmatched.length} request(s) matched no rule.\n\n${blocks.join('\n\n')}\n\n` +
    `Script them with mock.when(...), or add a fallback with mock.default().reply(...).` +
    (seed !== undefined ? `\nmock-llm seed: ${seed} (reproduce this run with MOCK_LLM_SEED=${seed})` : '')
  );
}

export const assertions = {
  toHaveReceivedRequest,
  toHaveReceivedRequestTimes,
  toHaveReceivedPrompt,
  toHaveOfferedTool,
  toHaveRequestedTool,
  toHaveReturnedToolResult,
  toHaveToolTrajectory,
  toHaveUsedTokensLessThan,
  toCostLessThan,
  toHaveNoUnmatchedRequests,
  toHaveMetExpectations,
};

// ---------------------------------------------------------------- helpers

function journalOf(target: AssertTarget): JournalLike {
  const j = target && typeof (target as JournalLike).all === 'function' ? (target as JournalLike) : (target as { journal?: JournalLike })?.journal;
  if (!j || typeof j.all !== 'function') throw new TypeError('mock-llm assertions expect a MockLLM or its journal, e.g. expect(mock).toHaveOfferedTool(...)');
  return j;
}

function select(target: AssertTarget, filter: EntryFilter = {}): JournalEntry[] {
  const endpoint = filter.endpoint ?? 'chat';
  const providers = filter.provider === undefined ? undefined : Array.isArray(filter.provider) ? filter.provider : [filter.provider];
  return journalOf(target)
    .all()
    .filter(
      (e) =>
        (endpoint === 'any' || e.endpoint === endpoint) &&
        (!providers || providers.includes(e.provider)) &&
        (filter.model === undefined || matchModel(filter.model, e.request.model)),
    );
}

function view(r: IRRequest): RequestView {
  return {
    provider: r.provider,
    endpoint: r.endpoint,
    model: r.model,
    system: r.system,
    lastUserMessage: lastUserText(r),
    messages: r.messages,
    tools: r.tools.map((t) => t.name),
    toolChoice: r.toolChoice,
    responseFormat: r.responseFormat,
    stream: r.stream,
    maxTokens: r.maxTokens,
    temperature: r.temperature,
    headers: r.headers,
  };
}

function promptTexts(r: IRRequest, where: 'any' | 'system' | 'user' | 'lastUser'): string[] {
  const user = r.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n'))
    .filter(Boolean);
  if (where === 'system') return r.system ? [r.system] : [];
  if (where === 'lastUser') return [lastUserText(r)];
  if (where === 'user') return user;
  return [...(r.system ? [r.system] : []), ...user];
}

/** Tool calls the mock returned, in order. */
function requestedCalls(entries: JournalEntry[]): ToolStep[] {
  return entries.flatMap((e) => (e.response?.content ?? []).flatMap((c) => (c.type === 'tool_call' ? [{ name: c.name, args: c.input }] : [])));
}

/**
 * Tool results the app sent, in order. Only parts after a request's last assistant
 * message count, so results repeated in later history aren't double counted.
 */
function returnedResults(entries: JournalEntry[]): Array<{ name: string; args?: unknown; content: string; isError?: boolean }> {
  const out: Array<{ name: string; args?: unknown; content: string; isError?: boolean }> = [];
  for (const e of entries) {
    const msgs = e.request.messages;
    const calls = new Map<string, { name: string; input: unknown }>();
    for (const m of msgs) for (const p of m.content) if (p.type === 'tool_call') calls.set(p.id, { name: p.name, input: p.input });
    let lastAssistant = -1;
    msgs.forEach((m, i) => m.role === 'assistant' && (lastAssistant = i));
    for (const m of msgs.slice(lastAssistant + 1)) {
      for (const p of m.content) {
        if (p.type !== 'tool_result') continue;
        const call = calls.get(p.toolCallId);
        out.push({ name: call?.name ?? p.toolCallId, args: call?.input, content: p.content, isError: p.isError });
      }
    }
  }
  return out;
}

function matchResultContent(expected: unknown, content: string): boolean {
  if (typeof expected === 'string' || expected instanceof RegExp || isAsymmetric(expected)) return matchText(expected as TextExpectation, content);
  try {
    return matchValue(expected, JSON.parse(content));
  } catch {
    return false;
  }
}

function isAsymmetric(v: unknown): v is AsymmetricMatcher {
  return !!v && typeof (v as AsymmetricMatcher).asymmetricMatch === 'function';
}

function matchText(expected: TextExpectation, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (expected instanceof RegExp) return regexTest(expected, actual);
  return actual.includes(expected);
}

/** Partial deep match (like toMatchObject), with RegExp and asymmetric matcher support. */
export function matchValue(expected: unknown, actual: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (expected instanceof RegExp) return typeof actual === 'string' && regexTest(expected, actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchValue(v, actual[i]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, v]) => matchValue(v, (actual as Record<string, unknown>)[k]));
  }
  return Object.is(expected, actual);
}

// ---------------------------------------------------------------- messages

function result(pass: boolean, claim: string, entries: JournalEntry[], expected: unknown, actual: unknown): AssertionResult {
  return {
    pass,
    expected,
    actual,
    message: () => `${pass ? 'Expected mock-llm NOT ' : 'Expected mock-llm '}${claim}\n\n${excerpt(entries)}`,
  };
}

function excerpt(entries: JournalEntry[]): string {
  if (!entries.length) return 'Requests received: none';
  const shown = entries.slice(-10);
  const lines = shown.map((e) => {
    const r = e.request;
    const reply = (e.response?.content ?? [])
      .map((c) => (c.type === 'tool_call' ? `tool_call ${c.name}(${clip(typeof c.input === 'string' ? c.input : JSON.stringify(c.input), 60)})` : c.type === 'text' ? `"${clip(c.text, 40)}"` : 'thinking'))
      .join(', ');
    const results = returnedResults([e]).map((x) => `${x.name}→${clip(x.content, 40)}`);
    return (
      `  #${e.id} ${e.provider} ${e.endpoint} ${r.model} [${e.status}]` +
      (r.system ? `\n      system: "${clip(r.system, 70)}"` : '') +
      `\n      last user: "${clip(lastUserText(r), 70)}"` +
      (r.tools.length ? `\n      tools offered: ${r.tools.map((t) => t.name).join(', ')}` : '') +
      (results.length ? `\n      tool results sent: ${results.join('; ')}` : '') +
      (reply ? `\n      mock replied: ${reply}${e.chaos ? ` (chaos: ${e.chaos.behaviour})` : ''}` : e.fault ? `\n      mock fault: ${e.fault.type}${e.chaos ? ' (chaos)' : ''}` : '')
    );
  });
  const more = entries.length > shown.length ? `  … ${entries.length - shown.length} earlier request(s) omitted\n` : '';
  const chaos = entries.find((e) => e.chaos);
  const hint = chaos
    ? `\nChaos affected ${entries.filter((e) => e.chaos).length} request(s): reproduce with MOCK_LLM_SEED=${chaos.chaos!.seed}`
    : '';
  return `Requests received (${entries.length}):\n${more}${lines.join('\n')}${hint}`;
}

function describeFilter(f: EntryFilter): string {
  const parts = Object.entries(f).map(([k, v]) => `${k}=${v instanceof RegExp ? v : JSON.stringify(v)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function fmt(v: unknown): string {
  if (v instanceof RegExp) return String(v);
  if (isAsymmetric(v)) return String((v as { toString(): string }).toString?.() ?? 'asymmetric matcher');
  try {
    return clip(
      JSON.stringify(v, (_k, x) => (x instanceof RegExp ? String(x) : isAsymmetric(x) ? `<${(x as { toString(): string }).toString()}>` : x)),
      300,
    );
  } catch {
    return String(v);
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
