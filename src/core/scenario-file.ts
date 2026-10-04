import { readFile } from 'node:fs/promises';
import { edge } from './edge.js';
import { faults } from './faults.js';
import type { Matcher, ReplyOptions, RuleBuilder } from './rules.js';
import type { Fault, IRResponse } from './types.js';

/**
 * Declarative scenario files (JSON or YAML) so QA can script mocks without code:
 *
 *   rules:
 *     - when: { lastUserMessage: "/refund/i" }
 *       reply: Refunds take 5 days.
 *     - when: { tool: get_weather }
 *       steps:
 *         - toolCall: { name: get_weather, input: { city: Paris } }
 *         - reply: It is sunny.
 *     - when: { model: gpt-4o }
 *       once: true
 *       fail: { rateLimit: { retryAfter: 2 } }
 *   scenarios:
 *     vip: { reply: Welcome back! }
 *   default: { lorem: { tokens: 40 } }
 */
export interface ScenarioFile {
  rules?: RuleDef[];
  scenarios?: Record<string, StepsDef>;
  default?: StepsDef;
}

export type StepDef = Record<string, unknown>;
export type StepsDef = StepDef & { steps?: StepDef[] };
export type RuleDef = StepsDef & { name?: string; when?: Record<string, unknown> | string; times?: number; once?: boolean; inject?: unknown; latency?: unknown };

export interface ScenarioTarget {
  when(matcher: Matcher, name?: string): RuleBuilder;
  scenario(name: string): RuleBuilder;
  default(): RuleBuilder;
}

const ACTIONS = ['reply', 'template', 'json', 'echo', 'lorem', 'toolCall', 'toolCalls', 'fromSchema', 'toolCallFromSchema', 'edge', 'fail'] as const;
const MODIFIERS = ['stopReason', 'thinking', 'usage', 'delay', 'chunkIntervalMs', 'expectToolResult', 'expectRequest'] as const;
const RULE_KEYS = ['name', 'when', 'times', 'once', 'inject', 'steps', 'latency'] as const;
const MATCHER_KEYS = ['provider', 'endpoint', 'model', 'lastUserMessage', 'system', 'anyMessage', 'hasTools', 'tool', 'tools', 'hasToolResult', 'turn', 'stream', 'responseFormat', 'headers'];
const REGEX_KEYS = ['model', 'lastUserMessage', 'system', 'anyMessage'];

/** Load a scenario file from disk (`.json`, `.yaml`, `.yml`). YAML needs the optional `yaml` package. */
export async function readScenarioFile(path: string): Promise<ScenarioFile> {
  const text = await readFile(path, 'utf8');
  if (/\.ya?ml$/i.test(path)) {
    let yaml: { parse(s: string): unknown };
    try {
      yaml = (await import('yaml')) as any;
    } catch {
      throw new Error(`mock-llm: loading ${path} requires the 'yaml' package (npm install -D yaml), or use JSON.`);
    }
    return yaml.parse(text) as ScenarioFile;
  }
  return JSON.parse(text) as ScenarioFile;
}

export function applyScenarioFile(target: ScenarioTarget, file: ScenarioFile, source = 'scenario'): void {
  if (!file || typeof file !== 'object') throw new Error(`${source}: expected an object with rules / scenarios / default`);
  for (const key of Object.keys(file)) {
    if (!['rules', 'scenarios', 'default'].includes(key)) throw new Error(`${source}: unknown top-level key '${key}'`);
  }
  (file.rules ?? []).forEach((rule, i) => {
    const where = `${source}: rules[${i}]`;
    check(rule, [...RULE_KEYS, ...ACTIONS, ...MODIFIERS], where);
    const matcher = typeof rule.when === 'string' ? { lastUserMessage: toRegex(rule.when) } : parseMatcher(rule.when ?? {}, where);
    let b!: RuleBuilder;
    located(`${where}.when`, () => {
      b = target.when(matcher, rule.name);
    });
    if (rule.once) b.once();
    if (typeof rule.times === 'number') b.times(rule.times);
    if (rule.latency !== undefined) located(where, () => b.latency(rule.latency as any));
    applySteps(b, rule, where);
    if (rule.inject !== undefined) {
      const inj = typeof rule.inject === 'string' ? { text: rule.inject } : (rule.inject as { text: string; position?: any });
      b.inject(inj.text, { position: inj.position });
    }
  });
  for (const [name, def] of Object.entries(file.scenarios ?? {})) {
    check(def, ['steps', ...ACTIONS, ...MODIFIERS], `${source}: scenarios.${name}`);
    applySteps(target.scenario(name), def, `${source}: scenarios.${name}`);
  }
  if (file.default) {
    check(file.default, ['steps', ...ACTIONS, ...MODIFIERS], `${source}: default`);
    applySteps(target.default(), file.default, `${source}: default`);
  }
}

function applySteps(b: RuleBuilder, def: StepsDef, where: string): void {
  const steps = def.steps ?? [def];
  const name = (def as RuleDef).name;
  steps.forEach((step, i) => {
    const at = def.steps ? `${where}.steps[${i}]` : where;
    // How expectation failures name this step: file › rule (and its name) › step.
    const location = `${where}${name ? ` ("${name}")` : ''}${def.steps ? ` › steps[${i}]` : ''}`;
    if (def.steps) check(step, [...ACTIONS, ...MODIFIERS], at);
    located(at, () => applyStep(b, step, at, location));
  });
}

function applyStep(b: RuleBuilder, step: StepDef, where: string, location: string): void {
  const actions = ACTIONS.filter((a) => a in step);
  if (actions.length !== 1) throw new Error(`${where}: expected exactly one of ${ACTIONS.join(', ')} (got ${actions.join(', ') || 'none'})`);
  const opts: ReplyOptions = {};
  if (step.stopReason) opts.stopReason = step.stopReason as ReplyOptions['stopReason'];
  if (step.thinking) opts.thinking = String(step.thinking);
  if (step.usage) opts.usage = step.usage as ReplyOptions['usage'];
  if (step.delay !== undefined) {
    if (actions[0] === 'fail') throw new Error(`${where}: delay is not supported on fail steps (use rule-level latency)`);
    opts.delay = step.delay as ReplyOptions['delay'];
  }
  if (step.expectToolResult !== undefined || step.expectRequest !== undefined) {
    if (actions[0] === 'fail') throw new Error(`${where}: expectations are not supported on fail steps`);
    if (step.expectToolResult !== undefined) {
      const e = step.expectToolResult as { name?: unknown; content?: unknown };
      if (!e || typeof e !== 'object' || typeof e.name !== 'string') throw new Error(`${where}: expectToolResult needs { name, content? }`);
      for (const k of Object.keys(e)) if (k !== 'name' && k !== 'content') throw new Error(`${where}: unknown key '${k}' in expectToolResult (allowed: name, content)`);
      opts.expectToolResult = { name: e.name, ...(e.content !== undefined && { content: revive(e.content) as any }) };
    }
    if (step.expectRequest !== undefined) {
      if (!step.expectRequest || typeof step.expectRequest !== 'object') throw new Error(`${where}: expectRequest must be an object`);
      opts.expectRequest = revive(step.expectRequest) as ReplyOptions['expectRequest'];
    }
    opts.location = location;
  }
  if (step.chunkIntervalMs !== undefined) {
    if (actions[0] === 'fail') throw new Error(`${where}: chunkIntervalMs is not supported on fail steps`);
    opts.chunkIntervalMs = step.chunkIntervalMs as number;
  }
  const v: any = step[actions[0]!];

  switch (actions[0]) {
    case 'reply':
      return void b.reply(typeof v === 'string' ? v : (v as IRResponse), opts);
    case 'template':
      return void b.replyTemplate(String(v), opts);
    case 'json':
      return void b.replyJson(v, opts);
    case 'echo':
      return void b.replyEcho(opts);
    case 'lorem':
      return void b.replyLorem({ ...(typeof v === 'object' ? v : { tokens: Number(v) || undefined }), ...opts });
    case 'toolCall':
      if (!v?.name) throw new Error(`${where}: toolCall needs a name`);
      return void b.replyToolCall(v.name, v.input ?? {}, { ...opts, text: v.text });
    case 'toolCalls':
      if (!Array.isArray(v)) throw new Error(`${where}: toolCalls must be a list`);
      return void b.replyToolCalls(v, opts);
    case 'fromSchema':
      return void b.replyFromSchema({ ...(typeof v === 'object' ? v : {}), ...opts });
    case 'toolCallFromSchema':
      return void b.replyToolCallFromSchema(typeof v === 'string' ? v : v?.name, { ...(typeof v === 'object' ? v : {}), ...opts });
    case 'edge':
      return void b.reply(callNamed(edge, v, where, 'edge case') as IRResponse, opts);
    case 'fail':
      return void b.fail(callNamed(faults, v, where, 'fault') as Fault);
  }
}

/** `name` or `{ name: arg }` or `{ name: [args] }` → lib[name](...args), with kebab/camel-insensitive names. */
function callNamed(lib: Record<string, (...args: any[]) => unknown>, spec: unknown, where: string, kind: string): unknown {
  const [name, arg] = typeof spec === 'string' ? [spec, undefined] : (Object.entries(spec as object)[0] ?? []);
  const norm = (s: string) => s.replace(/[-_]/g, '').toLowerCase();
  const key = Object.keys(lib).find((k) => norm(k) === norm(String(name)));
  if (!key) throw new Error(`${where}: unknown ${kind} '${name}'. Known: ${Object.keys(lib).join(', ')}`);
  return lib[key]!(...(arg === undefined ? [] : Array.isArray(arg) ? arg : [arg]));
}

/** Run `fn`, prefixing library validation errors with the scenario location. */
function located(where: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(msg.startsWith(where) ? msg : `${where}: ${msg.replace(/^mock-llm: /, '')}`);
  }
}

function parseMatcher(when: Record<string, unknown>, where: string): Matcher {
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(when)) {
    if (!MATCHER_KEYS.includes(k)) throw new Error(`${where}.when: unknown matcher '${k}'. Known: ${MATCHER_KEYS.join(', ')}`);
    if (REGEX_KEYS.includes(k) && typeof v === 'string') m[k] = toRegex(v);
    else if (k === 'headers' && v && typeof v === 'object') {
      m[k] = Object.fromEntries(Object.entries(v).map(([h, hv]) => [h, typeof hv === 'string' ? toRegex(hv) : hv]));
    } else m[k] = v;
  }
  return m as Matcher;
}

/** Deeply turn "/pattern/flags" strings into RegExps (for expectations). */
function revive(v: unknown): unknown {
  if (typeof v === 'string') return toRegex(v);
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  return v;
}

/** "/pattern/flags" → RegExp; anything else stays a substring match. */
function toRegex(s: string): string | RegExp {
  const m = s.match(/^\/(.+)\/([gimsuy]*)$/);
  return m ? new RegExp(m[1]!, m[2]) : s;
}

function check(obj: unknown, allowed: readonly string[], where: string): void {
  if (!obj || typeof obj !== 'object') throw new Error(`${where}: expected an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${where}: unknown key '${k}'`);
}
