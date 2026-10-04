import type { Rng } from './rng.js';
import type { RequestExpectation, TextExpectation } from '../assert/index.js';
import { validateDelay, validateLatency, type Delay, type LatencySpec } from './latency.js';
import { fakeFromSchema } from './schema.js';
import type { Endpoint, Fault, IRContent, IRRequest, IRResponse, Provider, StopReason } from './types.js';

type TextMatch = string | RegExp;

export interface Matcher {
  provider?: Provider | Provider[];
  endpoint?: Endpoint;
  /**
   * Model id: a glob when it contains `*` or `?` (matched against the whole id, e.g. `'claude-*'`),
   * otherwise a substring; or a RegExp.
   */
  model?: TextMatch;
  /** Substring or regex against the text of the last user message. */
  lastUserMessage?: TextMatch;
  /** Substring or regex against the system prompt. */
  system?: TextMatch;
  /** Substring or regex against any message text. */
  anyMessage?: TextMatch;
  /** Whether the request offers tools. */
  hasTools?: boolean;
  /** The request offers a tool with this name. */
  tool?: string;
  /** The request offers every one of these tools (it may offer others too). */
  tools?: string[];
  /** The last user turn carries tool results (i.e. agent loop continuation). */
  hasToolResult?: boolean;
  /** 1-based count of user turns in the conversation. */
  turn?: number;
  stream?: boolean;
  responseFormat?: 'text' | 'json_object' | 'json_schema';
  headers?: Record<string, TextMatch>;
  where?: (req: IRRequest) => boolean;
}

export interface ResponderContext {
  rng: Rng;
  /** Index of this call within the rule (0-based). */
  callIndex: number;
}

export type ResponseFn = (req: IRRequest, ctx: ResponderContext) => IRResponse | string | Promise<IRResponse | string>;

/** Checks run against the request a step answers (recorded on the journal entry; failures fail the test). */
export interface StepExpectation {
  /** Where this step was defined, e.g. `support.yaml: rules[1] ("refund") › steps[1]` or `rule "refund" › step 2`. */
  location: string;
  toolResult?: { name: string; content?: TextExpectation | Record<string, unknown> | unknown[] };
  request?: RequestExpectation;
}

export type Step =
  | { kind: 'respond'; fn: ResponseFn; delay?: Delay; chunkIntervalMs?: number; expect?: StepExpectation }
  | { kind: 'fault'; fault: Fault };

export interface ReplyOptions {
  stopReason?: StopReason;
  usage?: IRResponse['usage'];
  thinking?: string;
  /** Time before this step's first byte/token (overrides rule and global latency). */
  delay?: Delay;
  /** Pause between streamed events for this step (overrides `tokensPerSec`). Pairs with `{ chunks }`. */
  chunkIntervalMs?: number;
  /** Expect the request this step answers to carry a tool result (checked with `toHaveReturnedToolResult`). */
  expectToolResult?: { name: string; content?: TextExpectation | Record<string, unknown> | unknown[] };
  /** Expect the request this step answers to match partially (checked with `toHaveReceivedRequest`). */
  expectRequest?: RequestExpectation;
  /** Overrides the location shown in expectation failures (scenario files set it). */
  location?: string;
}

/** Exact stream pieces: `reply({ chunks: ['Hel', 'lo'] })` streams "Hel" then "lo" (non-streaming gets "Hello"). */
export interface ChunkedText {
  chunks: string[];
}

export interface InjectOptions {
  position?: 'prefix' | 'suffix' | 'replace';
}

const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo'
).split(' ');

export class Rule {
  readonly steps: Step[] = [];
  private calls = 0;
  limit?: number;
  injections: Array<{ text: string; position: NonNullable<InjectOptions['position']> }> = [];
  /** Latency for every step of this rule (overrides global latency; a step's `delay` wins). */
  latency?: LatencySpec;
  /** How failure messages refer to this rule, e.g. `rule "refund"` or `rule #2`. */
  label: string;

  constructor(
    readonly matcher: Matcher,
    readonly name?: string,
    label?: string,
  ) {
    this.label = label ?? (name ? `rule "${name}"` : 'rule');
    const { tools } = matcher;
    if (tools !== undefined && !(Array.isArray(tools) && tools.length > 0 && tools.every((t) => typeof t === 'string' && t))) {
      throw new Error(`mock-llm: invalid tools matcher ${JSON.stringify(tools)}: list at least one tool name (use hasTools: false for "no tools")`);
    }
  }

  get exhausted(): boolean {
    return this.limit !== undefined && this.calls >= this.limit;
  }

  matches(req: IRRequest): boolean {
    return !this.exhausted && matches(this.matcher, req);
  }

  /** Consume the next step. Sequences advance per call; the last step repeats. */
  take(): { step: Step; callIndex: number } {
    const callIndex = this.calls++;
    const step = this.steps[Math.min(callIndex, this.steps.length - 1)] ?? {
      kind: 'respond',
      fn: () => 'Mock response.',
    };
    return { step, callIndex };
  }

  reset(): void {
    this.calls = 0;
  }
}

/** Fluent builder returned by `mock.when(...)`. Each reply/fail call appends a sequence step. */
export class RuleBuilder {
  constructor(readonly rule: Rule) {}

  /** Readability sugar: `.replyToolCall(...).then.reply(...)`. */
  get then(): this {
    return this;
  }

  /** Match only the first `n` requests, then fall through to other rules. */
  times(n: number): this {
    this.rule.limit = n;
    return this;
  }

  once(): this {
    return this.times(1);
  }

  /** Latency for this rule's replies, e.g. `.latency({ firstTokenMs: { min: 200, max: 800 }, tokensPerSec: 30 })`. */
  latency(spec: LatencySpec): this {
    validateLatency(spec);
    this.rule.latency = spec;
    return this;
  }

  /** Plain text, a full IRResponse, or a function of the request. */
  reply(response: string | IRResponse | ChunkedText | ResponseFn, opts: ReplyOptions = {}): this {
    const resolved = isChunked(response) ? chunkedResponse(response) : response;
    const fn: ResponseFn = typeof resolved === 'function' ? resolved : () => resolved;
    validateDelay(opts.delay);
    if (opts.chunkIntervalMs !== undefined && !(typeof opts.chunkIntervalMs === 'number' && opts.chunkIntervalMs >= 0)) {
      throw new Error(`mock-llm: invalid chunkIntervalMs ${JSON.stringify(opts.chunkIntervalMs)}: must be a number ≥ 0`);
    }
    let expect: StepExpectation | undefined;
    if (opts.expectToolResult || opts.expectRequest) {
      const tr = opts.expectToolResult;
      if (tr && !(tr && typeof tr === 'object' && typeof tr.name === 'string' && tr.name)) {
        throw new Error(`mock-llm: invalid expectToolResult ${JSON.stringify(tr)}: needs { name, content? }`);
      }
      if (opts.expectRequest !== undefined && !(opts.expectRequest && typeof opts.expectRequest === 'object')) {
        throw new Error(`mock-llm: invalid expectRequest ${JSON.stringify(opts.expectRequest)}: expected an object`);
      }
      expect = {
        location: opts.location ?? `${this.rule.label} › step ${this.rule.steps.length + 1}`,
        ...(tr && { toolResult: tr }),
        ...(opts.expectRequest && { request: opts.expectRequest }),
      };
    }
    return this.push(async (req, ctx) => applyReplyOptions(toResponse(await fn(req, ctx)), opts), opts.delay, opts.chunkIntervalMs, expect);
  }

  /** Text with `{{lastUserMessage}}`, `{{system}}`, `{{model}}`, `{{provider}}` placeholders. */
  replyTemplate(template: string, opts: ReplyOptions = {}): this {
    return this.reply((req) => renderTemplate(template, req), opts);
  }

  /** Echo the last user message back. */
  replyEcho(opts: ReplyOptions = {}): this {
    return this.reply((req) => lastUserText(req), opts);
  }

  /** Deterministic filler text of roughly `tokens` tokens. */
  replyLorem(options: { tokens?: number } & ReplyOptions = {}): this {
    const { tokens = 50, ...opts } = options;
    return this.reply((_req, ctx) => {
      const words: string[] = [];
      for (let i = 0; i < tokens; i++) words.push(ctx.rng.pick(LOREM));
      const s = words.join(' ');
      return s.charAt(0).toUpperCase() + s.slice(1) + '.';
    }, opts);
  }

  /** Reply with JSON text (as a model would for structured output). */
  replyJson(value: unknown, opts: ReplyOptions = {}): this {
    return this.reply(JSON.stringify(value), opts);
  }

  /**
   * Structured output: JSON generated from the request's response schema
   * (OpenAI `response_format`/`text.format`, Anthropic `output_config.format`,
   * Gemini `responseSchema`), or from `schema` if given. `violate: true` returns
   * JSON that breaks the schema, to test validation paths.
   */
  replyFromSchema(opts: { schema?: unknown; violate?: boolean } & ReplyOptions = {}): this {
    const { schema, violate, ...rest } = opts;
    return this.reply((req, ctx) => {
      const s = schema ?? req.responseFormat?.schema;
      const value = s ? fakeFromSchema(s, ctx.rng, { violate }) : { mock: true };
      return JSON.stringify(value);
    }, rest);
  }

  /**
   * Call an offered tool (by name, or the first one) with arguments generated
   * from its input schema. `violate: true` breaks the schema.
   */
  replyToolCallFromSchema(name?: string, opts: { violate?: boolean } & ReplyOptions = {}): this {
    const { violate, ...rest } = opts;
    return this.reply((req, ctx) => {
      const tool = name ? req.tools.find((t) => t.name === name) : req.tools[0];
      const input = tool?.inputSchema ? fakeFromSchema(tool.inputSchema, ctx.rng, { violate }) : {};
      return { content: [{ type: 'tool_call', name: tool?.name ?? name ?? 'unknown_tool', input }], stopReason: 'tool_use' };
    }, rest);
  }

  /** Ask the app to call a tool. `input` may be a raw string to simulate malformed args. */
  replyToolCall(name: string, input: unknown = {}, opts: ReplyOptions & { text?: string } = {}): this {
    return this.replyToolCalls([{ name, input }], opts);
  }

  /** Several (parallel) tool calls in one assistant turn. */
  replyToolCalls(calls: Array<{ name: string; input?: unknown; id?: string }>, opts: ReplyOptions & { text?: string } = {}): this {
    const { text, ...rest } = opts;
    const content: IRContent[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of calls) content.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input ?? {} });
    return this.reply({ content, stopReason: 'tool_use' }, rest);
  }

  /** Fail with a fault from `faults.*`. */
  fail(fault: Fault): this {
    this.rule.steps.push({ kind: 'fault', fault });
    return this;
  }

  /** Add text to every text response this rule produces (edge-case seeding). */
  inject(text: string, opts: InjectOptions = {}): this {
    this.rule.injections.push({ text, position: opts.position ?? 'suffix' });
    return this;
  }

  private push(fn: ResponseFn, delay?: Delay, chunkIntervalMs?: number, expect?: StepExpectation): this {
    this.rule.steps.push({
      kind: 'respond',
      fn,
      ...(delay !== undefined && { delay }),
      ...(chunkIntervalMs !== undefined && { chunkIntervalMs }),
      ...(expect && { expect }),
    });
    return this;
  }
}

function isChunked(v: unknown): v is ChunkedText {
  return !!v && typeof v === 'object' && 'chunks' in v && !('content' in v);
}

function chunkedResponse({ chunks }: ChunkedText): IRResponse {
  if (!Array.isArray(chunks) || !chunks.length || !chunks.every((c) => typeof c === 'string')) {
    throw new Error(`mock-llm: invalid chunks ${JSON.stringify(chunks)}: expected a non-empty array of strings`);
  }
  return { content: [{ type: 'text', text: chunks.join(''), chunks: [...chunks] }] };
}

export function toResponse(r: IRResponse | string): IRResponse {
  return typeof r === 'string' ? { content: [{ type: 'text', text: r }] } : r;
}

function applyReplyOptions(r: IRResponse, opts: ReplyOptions): IRResponse {
  const out: IRResponse = { ...r, content: [...r.content] };
  if (opts.thinking) out.content.unshift({ type: 'thinking', text: opts.thinking });
  if (opts.stopReason) out.stopReason = opts.stopReason;
  if (opts.usage) out.usage = { ...out.usage, ...opts.usage };
  return out;
}

export function applyInjections(r: IRResponse, injections: Rule['injections']): IRResponse {
  if (!injections.length) return r;
  let content = r.content.map((c) => ({ ...c }));
  if (!content.some((c) => c.type === 'text')) content = [{ type: 'text', text: '' }, ...content];
  for (const inj of injections) {
    const block = content.find((c) => c.type === 'text') as { type: 'text'; text: string; chunks?: string[] };
    if (inj.position === 'replace') {
      block.text = inj.text;
      if (block.chunks) block.chunks = [inj.text];
    } else if (inj.position === 'prefix') {
      block.text = inj.text + block.text;
      if (block.chunks) block.chunks = [inj.text + (block.chunks[0] ?? ''), ...block.chunks.slice(1)];
    } else {
      block.text = block.text + inj.text;
      if (block.chunks) block.chunks = [...block.chunks, inj.text]; // injected text arrives as its own final chunk
    }
  }
  return { ...r, content };
}

export function lastUserText(req: IRRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    const text = m.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    if (text || !m.content.some((p) => p.type === 'tool_result')) return text;
  }
  return '';
}

function allText(req: IRRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : ''))
    .join('\n');
}

function renderTemplate(template: string, req: IRRequest): string {
  const vars: Record<string, string> = {
    lastUserMessage: lastUserText(req),
    system: req.system ?? '',
    model: req.model,
    provider: req.provider,
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * Model matching shared by rules and assertion filters: a string with `*` / `?` is a glob over
 * the whole id; any other string is a substring; a RegExp is tested as-is.
 */
export function matchModel(m: TextMatch, model: string | undefined): boolean {
  if (model === undefined) return false;
  if (typeof m === 'string' && /[*?]/.test(m)) return globToRegExp(m).test(model);
  return test(m, model);
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

function test(m: TextMatch, value: string | undefined): boolean {
  if (value === undefined) return false;
  return typeof m === 'string' ? value.includes(m) : m.test(value);
}

export function matches(m: Matcher, req: IRRequest): boolean {
  if (m.provider && !(Array.isArray(m.provider) ? m.provider : [m.provider]).includes(req.provider)) return false;
  if ((m.endpoint ?? 'chat') !== req.endpoint) return false;
  if (m.model !== undefined && !matchModel(m.model, req.model)) return false;
  if (m.lastUserMessage !== undefined && !test(m.lastUserMessage, lastUserText(req))) return false;
  if (m.system !== undefined && !test(m.system, req.system)) return false;
  if (m.anyMessage !== undefined && !test(m.anyMessage, allText(req))) return false;
  if (m.hasTools !== undefined && m.hasTools !== req.tools.length > 0) return false;
  if (m.tool !== undefined && !req.tools.some((t) => t.name === m.tool)) return false;
  if (m.tools !== undefined && !m.tools.every((name) => req.tools.some((t) => t.name === name))) return false;
  if (m.hasToolResult !== undefined) {
    const last = req.messages.at(-1);
    const has = !!last && last.role !== 'assistant' && last.content.some((p) => p.type === 'tool_result');
    if (has !== m.hasToolResult) return false;
  }
  if (m.turn !== undefined) {
    const turns = req.messages.filter((x) => x.role === 'user' && x.content.some((p) => p.type === 'text')).length;
    if (turns !== m.turn) return false;
  }
  if (m.stream !== undefined && m.stream !== req.stream) return false;
  if (m.responseFormat !== undefined && (req.responseFormat?.type ?? 'text') !== m.responseFormat) return false;
  if (m.headers) {
    for (const [k, v] of Object.entries(m.headers)) if (!test(v, req.headers[k.toLowerCase()])) return false;
  }
  if (m.where && !m.where(req)) return false;
  return true;
}
