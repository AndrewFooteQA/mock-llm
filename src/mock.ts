import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { constants as h2, createServer as createH2Server, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { toHaveMetExpectations, toHaveNoUnmatchedRequests, toHaveReceivedRequest, toHaveReturnedToolResult, type AssertTarget } from './assert/index.js';
import { Journal, type JournalEntry, type WireRecord } from './core/journal.js';
import { applyContentChaos, DEFAULT_CHAOS_FAULTS, pickBehaviour, validateChaos, type ChaosBehaviour, type ChaosOptions } from './core/chaos.js';
import { latencyRng, sampleDelay, validateLatency, type AppliedLatency, type Delay, type LatencySpec } from './core/latency.js';
import { Rng } from './core/rng.js';
import { applyInjections, lastUserText, matchModel, Rule, RuleBuilder, toResponse, type Matcher, type Step } from './core/rules.js';
import { DEFAULT_PRICING, type PriceTable } from './core/pricing.js';
import { applyScenarioFile, readScenarioFile, type ScenarioFile } from './core/scenario-file.js';
import { builtinScenarios } from './core/scenarios.js';
import { contentTokens, requestTokens } from './core/tokens.js';
import type { Endpoint, ErrorSpec, Fault, IRRequest, IRResponse, IRUsage, Provider } from './core/types.js';
import { ApiError, type Adapter, type HttpReply, type RenderContext } from './providers/adapter.js';
import { anthropicAdapter } from './providers/anthropic.js';
import { decodeMessage } from './providers/eventstream.js';
import { bedrockAdapter } from './providers/bedrock.js';
import { geminiAdapter } from './providers/gemini.js';
import { openaiAdapter } from './providers/openai.js';

export interface MockLLMOptions {
  /** Port to listen on; 0 (default) picks a free ephemeral port. */
  port?: number;
  /** Interface to bind; defaults to localhost only. */
  host?: string;
  /** Seed for lorem text, ids and chaos faults. */
  seed?: number;
  /**
   * Simulated latency for every reply. Defaults to none, so tests stay fast. `firstTokenMs` may be
   * a number, `{ min, max }` or `{ distribution: 'normal', mean, stdDev }` (seeded). Rules
   * (`.latency()`) and steps (`{ delay }`) override it.
   */
  latency?: LatencySpec;
  /** If set, requests must carry one of these API keys or get a native 401. */
  apiKeys?: string[];
  /** Model ids returned by the models endpoints. */
  models?: string[];
  /** Randomly inject faults into a fraction of chat requests (seeded, so reproducible). */
  chaos?: ChaosOptions;
  /** What to do when no rule matches a chat request. Defaults to a short canned reply. */
  onUnmatched?: 'reply' | 'error';
  /**
   * Strict mode: a chat request no rule matches gets a native 400 error (never retried by SDKs),
   * and `assertNoUnmatched()` / the test-framework helpers fail the test, even if the app
   * swallowed the error. Unmatched requests are flagged in the journal either way.
   */
  strict?: boolean;
  /** USD per 1M tokens by model id / id prefix, merged over the built-in Claude prices. */
  pricing?: PriceTable;
  /** Scenario files (JSON/YAML) loaded on start() and re-applied by every reset(), so they act as a per-file baseline. */
  scenarioFiles?: string[];
  /** Record each raw HTTP exchange in `journal` entries' `wire` field (default true, capped at 256 KB per body). */
  recordWire?: boolean;
  /**
   * Context windows in tokens, keyed by model id or glob (`{ 'gpt-4o': 128000, 'claude-*': 200000, '*': 8000 }`).
   * A chat request whose **approximate** input tokens (~4 characters per token: system prompt, messages, tool
   * definitions; output `max_tokens` not counted) exceed its model's window gets the provider's native
   * context-length error, before any rule runs. An exact id wins, then the longest matching glob.
   */
  contextWindow?: Record<string, number>;
}

/** Event payloads. `entry` is the live journal entry (filled in as the exchange progresses). */
export interface MockLLMEvents {
  /** A request was received and resolved (rule chosen, `unmatched` known). Always first. */
  request: (event: { entry: JournalEntry }) => void;
  /** The request matched no rule / scenario / default() (fires right after `request`). */
  unmatched: (event: { entry: JournalEntry }) => void;
  /** One streamed chunk as sent. `data` is the raw string or bytes; `text` is readable (Bedrock frames decoded). */
  chunk: (event: { entry: JournalEntry; index: number; data: string | Uint8Array; text: string }) => void;
  /** The exchange finished without an injected fault (any status, including validation errors). Terminal. */
  response: (event: { entry: JournalEntry }) => void;
  /** An injected fault ended the exchange (error, reset, timeout, stream cut / error). Terminal. */
  fault: (event: { entry: JournalEntry; fault: Fault }) => void;
}
export type MockLLMEventName = keyof MockLLMEvents;

export type { ChaosOptions } from './core/chaos.js';

const DEFAULT_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'o4-mini',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'grok-4',
];

const ADAPTERS: Record<Provider, Adapter> = { openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter, bedrock: bedrockAdapter };

type Req = IncomingMessage | Http2ServerRequest;
type Res = ServerResponse | Http2ServerResponse;

const WIRE_LIMIT = 256 * 1024;
/** Pause before a mid-stream error frame (see the stream loop). */
const STREAM_ERROR_GAP_MS = 50;
/** Response → its chunk-event emitter, set per exchange in handle(). */
const CHUNKS = new WeakMap<object, (data: string | Uint8Array) => void>();
/** Response → its wire record, so every send path can log without extra plumbing. */
const WIRE = new WeakMap<object, WireRecord['response']>();

const MAGIC_TOKEN = /\[\[mock:([\w-]+)\]\]/;

export class MockLLM {
  readonly journal: Journal;
  /** Effective USD-per-1M-token prices (built-in Claude prices + `options.pricing`). */
  readonly pricing: PriceTable;
  /**
   * The effective seed: `MOCK_LLM_SEED` if set (to reproduce a failing run), else `options.seed`, else 1.
   * Drives lorem text, ids, schema values, chaos and random latency.
   */
  readonly seed: number;
  private state = new Map<string, unknown>();
  private rules: Rule[] = [];
  private fallback?: Rule;
  private scenarios = new Map<string, Rule>();
  /** `options.scenarioFiles`, parsed once on start() and re-applied by reset(). */
  private baselineFiles: Array<{ path: string; file: ScenarioFile }> = [];
  private rng: Rng;
  private latencyRng: Rng;
  private chaosOptions?: ChaosOptions;
  private server?: Server;
  private sockets = new Set<Socket>();
  private listeners: { [K in MockLLMEventName]: Set<MockLLMEvents[K]> } = {
    request: new Set(),
    unmatched: new Set(),
    chunk: new Set(),
    response: new Set(),
    fault: new Set(),
  };
  private baseUrl?: string;
  private nextId = 1;

  constructor(private readonly options: MockLLMOptions = {}) {
    validateLatency(options.latency);
    validateChaos(options.chaos);
    for (const [key, tokens] of Object.entries(options.contextWindow ?? {})) {
      if (!(typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0)) {
        throw new Error(`mock-llm: invalid contextWindow[${JSON.stringify(key)}] ${JSON.stringify(tokens)}: must be a positive number of tokens`);
      }
    }
    this.seed = effectiveSeed(options.seed);
    this.rng = new Rng(this.seed);
    this.latencyRng = latencyRng(this.seed);
    this.chaosOptions = options.chaos;
    this.pricing = { ...DEFAULT_PRICING, ...options.pricing };
    this.journal = new Journal(this.pricing, effectiveSeed(options.seed));
  }

  /** Base URLs to hand to each SDK (`baseURL` option or `*_BASE_URL` env var). */
  get urls(): MockUrls {
    if (!this.baseUrl) throw new Error('mock-llm: call start() first');
    return urlsFor(this.baseUrl);
  }

  /** Environment variables pointing SDKs (and tools like Claude Code) at this mock. */
  env(): Record<string, string> {
    return envFor(this.urls.base, this.options.apiKeys?.[0]);
  }

  /** Add rules/scenarios from a scenario file path (JSON/YAML) or an already-parsed object. */
  async load(source: string | ScenarioFile): Promise<this> {
    const file = typeof source === 'string' ? await readScenarioFile(source) : source;
    applyScenarioFile(this, file, typeof source === 'string' ? source : 'scenario');
    return this;
  }

  /**
   * Add a rule. The most recently added matching rule wins, so per-test rules
   * override shared ones from `beforeEach`. A string/RegExp matches the last user message.
   */
  when(matcher: Matcher | string | RegExp = {}, name?: string): RuleBuilder {
    const m = typeof matcher === 'string' || matcher instanceof RegExp ? { lastUserMessage: matcher } : matcher;
    const rule = new Rule(m, name, name ? `rule "${name}"` : `rule #${this.rules.length + 1}`);
    this.rules.push(rule);
    return new RuleBuilder(rule);
  }

  /** Response used when no rule matches. */
  default(): RuleBuilder {
    this.fallback = new Rule({}, 'default', 'default()');
    return new RuleBuilder(this.fallback);
  }

  /** Define (or override) a named scenario selectable via `x-mock-scenario` / `[[mock:name]]`. */
  scenario(name: string): RuleBuilder {
    const rule = new Rule({}, `scenario:${name}`, `scenario "${name}"`);
    this.scenarios.set(name, rule);
    return new RuleBuilder(rule);
  }

  /** Turn random fault injection on (or off with `null`). */
  chaos(options: ChaosOptions | null): this {
    validateChaos(options ?? undefined);
    this.chaosOptions = options ?? undefined;
    return this;
  }

  /**
   * Subscribe to mock activity. Per request the order is always
   * `request → unmatched? → chunk* → (response | fault)`, exactly one terminal event.
   * Listeners survive `reset()`. A throwing (or rejecting) listener never affects the
   * response sent to the app; the error is reported via `console.error`.
   */
  on<K extends MockLLMEventName>(event: K, listener: MockLLMEvents[K]): this {
    this.listeners[event].add(listener);
    return this;
  }

  off<K extends MockLLMEventName>(event: K, listener: MockLLMEvents[K]): this {
    this.listeners[event].delete(listener);
    return this;
  }

  private emit<K extends MockLLMEventName>(event: K, payload: Parameters<MockLLMEvents[K]>[0]): void {
    for (const listener of this.listeners[event]) {
      try {
        const out = (listener as (p: typeof payload) => unknown)(payload);
        if (out && typeof (out as Promise<unknown>).catch === 'function') {
          (out as Promise<unknown>).catch((err) => console.error(`[mock-llm] async "${event}" listener failed:`, err));
        }
      } catch (err) {
        console.error(`[mock-llm] "${event}" listener threw:`, err);
      }
    }
  }

  /**
   * Throw if any chat request matched no rule (see `strict`). The error lists each unexpected
   * request and suggests the `mock.when(...)` to add. The Vitest helper calls this after each
   * test when `strict` is on.
   */
  assertNoUnmatched(): void {
    const r = toHaveNoUnmatchedRequests(this);
    if (!r.pass) throw new UnmatchedRequestError(r.message());
  }

  /**
   * Throw if any scenario expectation (`expectToolResult` / `expectRequest` on a step) failed. The error names
   * each one's scenario, rule and step. The Vitest/Jest/Playwright helpers call this after every test.
   */
  assertExpectations(): void {
    const r = toHaveMetExpectations(this);
    if (!r.pass) throw new ExpectationError(r.message());
  }

  /**
   * Clear rules, scenarios, chaos and the journal (server keeps running). Rules from `options.scenarioFiles`
   * are re-applied fresh (sequence positions and `.times()` counts start over); `load()`ed ones are cleared.
   */
  reset(): void {
    this.rules = [];
    this.fallback = undefined;
    this.scenarios.clear();
    for (const { path, file } of this.baselineFiles) applyScenarioFile(this, file, path);
    this.chaosOptions = this.options.chaos;
    this.journal.clear();
    this.state.clear();
    this.rng = new Rng(this.seed);
    this.latencyRng = latencyRng(this.seed);
  }

  async start(): Promise<this> {
    if (this.server) return this;
    this.baselineFiles = [];
    for (const path of this.options.scenarioFiles ?? []) {
      const file = await readScenarioFile(path);
      applyScenarioFile(this, file, path);
      this.baselineFiles.push({ path, file });
    }
    const onRequest = (req: Req, res: Res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) head(res, 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock-llm internal error: ${err?.message ?? err}` } }));
      });
    };
    // One port speaks HTTP/1.1 and cleartext HTTP/2 (the AWS SDK uses h2 for Bedrock):
    // sniff the HTTP/2 connection preface and hand the socket to the right server.
    const h1 = createServer(onRequest);
    const h2c = createH2Server(onRequest);
    const server = createNetServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.once('data', (first: Buffer) => {
        socket.pause();
        socket.unshift(first);
        (first.subarray(0, 3).toString('latin1') === 'PRI' ? h2c : h1).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', resolve);
    });
    const { port, address } = server.address() as AddressInfo;
    this.baseUrl = `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
    this.server = server;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------

  private async handle(req: Req, res: Res): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = req.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(req.headers)
        .filter(([k]) => !k.startsWith(':'))
        .map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : (v ?? '')]),
    );

    if (url.pathname.startsWith('/__mock/')) return this.control(method, url.pathname, req, res);

    const resolved = resolveProvider(url.pathname, headers);
    if (!resolved) return sendJson(res, { status: 404, body: { error: { message: `mock-llm: no provider serves ${url.pathname}` } } });
    const adapter = ADAPTERS[resolved.provider];
    const path = resolved.path;
    const startedAt = Date.now();
    const ctx: RenderContext = {
      rng: this.rng,
      usage: { inputTokens: 0, outputTokens: 0 },
      created: Math.floor(startedAt / 1000),
      models: this.options.models ?? DEFAULT_MODELS,
      state: this.state,
    };

    const rawBody = await readBody(req);
    const endpoint = adapter.route(method, path);
    let ir: IRRequest = {
      provider: adapter.provider,
      endpoint: endpoint ?? 'unknown',
      path,
      model: '',
      messages: [],
      tools: [],
      stream: false,
      headers,
      raw: undefined,
    };
    const entry: JournalEntry = {
      id: this.nextId++,
      provider: adapter.provider,
      endpoint: ir.endpoint,
      method,
      path,
      request: ir,
      status: 0,
      startedAt,
    };
    this.journal.add(entry);
    if (this.options.recordWire !== false) {
      entry.wire = {
        request: { method, url: url.pathname + url.search, headers, body: cap(rawBody).text },
        response: { body: '' },
      };
      WIRE.set(res, entry.wire.response);
    }
    const finish = (status: number) => {
      entry.status = status;
      entry.durationMs = Date.now() - startedAt;
    };
    const sendError = (spec: ErrorSpec) => {
      const reply = adapter.error(spec, ctx);
      finish(reply.status);
      sendJson(res, reply);
    };
    let requestEmitted = false;
    const emitRequest = () => {
      if (requestEmitted) return;
      requestEmitted = true;
      this.emit('request', { entry });
      if (entry.unmatched) this.emit('unmatched', { entry });
    };
    let chunkIndex = 0;
    CHUNKS.set(res, (data) => {
      emitRequest();
      this.emit('chunk', { entry, index: chunkIndex++, data, text: chunkText(data) });
    });

    try {
      await this.exchange(endpoint, rawBody, ir, entry, adapter, ctx, headers, path, res, finish, sendError, emitRequest);
    } finally {
      emitRequest();
      if (entry.fault) this.emit('fault', { entry, fault: entry.fault });
      else this.emit('response', { entry });
    }
  }

  private async exchange(
    endpoint: Endpoint | null,
    rawBody: string,
    ir: IRRequest,
    entry: JournalEntry,
    adapter: Adapter,
    ctx: RenderContext,
    headers: Record<string, string>,
    path: string,
    res: Res,
    finish: (status: number) => void,
    sendError: (spec: ErrorSpec) => void,
    emitRequest: () => void,
  ): Promise<void> {
    const method = entry.method;
    if (!endpoint) return sendError({ kind: 'not_found', message: `Unknown endpoint: ${method} ${path}` });

    try {
      let body: any = {};
      if (rawBody.length) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new ApiError({ kind: 'bad_request', message: 'Could not parse request body as JSON.' });
        }
      }
      // Keep the raw body even if validation rejects it, so failures are debuggable.
      entry.request = { ...ir, raw: body };
      ir = parseRequest(adapter, endpoint, body, headers, path, this.state);
      entry.request = ir;

      if (this.options.apiKeys) {
        const key = adapter.apiKey(headers);
        if (!key || !this.options.apiKeys.includes(key)) throw new ApiError({ kind: 'auth' });
      }

      ctx.usage.inputTokens = requestTokens(ir);

      // Context window: the provider rejects an oversized prompt whatever reply was scripted.
      const limit = endpoint === 'chat' ? this.contextWindowFor(ir.model) : undefined;
      if (limit !== undefined && ctx.usage.inputTokens > limit) {
        const fault: Fault = { type: 'error', error: { kind: 'context_length', details: { limit, inputTokens: ctx.usage.inputTokens } } };
        entry.fault = fault;
        entry.matchedBy = 'contextWindow';
        emitRequest();
        return await this.applyFault(fault, adapter, ir, ctx, res, finish, () => this.resolveLatency(undefined, undefined));
      }
      const { step, callIndex, rule, matchedBy, unmatched, chaos } = this.pickStep(ir);
      entry.matchedBy = matchedBy;
      if (chaos === 'error') entry.chaos = { seed: this.seed, behaviour: 'error' };
      if (step?.kind === 'respond' && step.expect) entry.expectations = checkExpectations(step.expect, entry);
      if (unmatched) entry.unmatched = true;
      emitRequest();

      if (step?.kind === 'fault') {
        entry.fault = step.fault;
        return await this.applyFault(step.fault, adapter, ir, ctx, res, finish, () => (entry.latency = this.resolveLatency(rule, undefined)));
      }

      if (endpoint !== 'chat') {
        const reply = adapter.other(ir, ctx);
        finish(reply.status);
        return sendJson(res, reply);
      }

      let response: IRResponse;
      if (step) {
        response = toResponse(await step.fn(ir, { rng: this.rng, callIndex }));
      } else if (this.options.strict) {
        throw new ApiError({
          kind: 'bad_request',
          message: `mock-llm strict mode: no rule matched this request (last user message: ${JSON.stringify(lastUserText(ir).slice(0, 200))}). Add a rule with mock.when(...); the test fails via assertNoUnmatched().`,
        });
      } else if (this.options.onUnmatched === 'error') {
        throw new ApiError({ kind: 'bad_request', message: `mock-llm: no rule matched (last user message: ${JSON.stringify(lastUserText(ir).slice(0, 200))})` });
      } else {
        response = { content: [{ type: 'text', text: 'This is a mock response from mock-llm.' }] };
      }
      response = applyInjections(response, [
        ...(rule?.injections ?? []),
        ...(headers['x-mock-inject'] ? [{ text: headers['x-mock-inject'], position: 'suffix' as const }] : []),
      ]);
      if (chaos && chaos !== 'error') {
        response = applyContentChaos(chaos, response, ir);
        entry.chaos = { seed: this.seed, behaviour: chaos };
      }
      entry.response = response;
      entry.latency = this.resolveLatency(rule, step?.kind === 'respond' ? step.delay : undefined, step?.kind === 'respond' ? step.chunkIntervalMs : undefined);
      await this.sendResponse(adapter, ir, response, ctx, res, finish, entry.latency);
      entry.usage = ctx.usage;
    } catch (err) {
      if (err instanceof ApiError) return sendError(err.spec);
      throw err;
    }
  }

  private pickStep(ir: IRRequest): { step?: Step; callIndex: number; rule?: Rule; matchedBy?: string; unmatched?: boolean; chaos?: ChaosBehaviour } {
    const scenarioName = ir.headers['x-mock-scenario'] ?? lastUserText(ir).match(MAGIC_TOKEN)?.[1];
    if (scenarioName) {
      const custom = this.scenarios.get(scenarioName);
      if (custom) return { ...custom.take(), rule: custom, matchedBy: custom.name };
      const builtin = builtinScenarios[scenarioName];
      if (builtin) return { step: builtin, callIndex: 0, matchedBy: `scenario:${scenarioName}` };
      throw new ApiError({ kind: 'bad_request', message: `mock-llm: unknown scenario '${scenarioName}'. Known: ${[...this.scenarios.keys(), ...Object.keys(builtinScenarios)].join(', ')}` });
    }

    let contentChaos: Exclude<ChaosBehaviour, 'error'> | undefined;
    if (ir.endpoint === 'chat' && this.chaosOptions && this.rng.next() < this.chaosOptions.rate) {
      const behaviour = pickBehaviour(this.chaosOptions, ir, this.rng);
      if (behaviour === 'error') {
        const pool = this.chaosOptions.faults ?? DEFAULT_CHAOS_FAULTS;
        // Chaos replaces the reply, but the request still counts as unmatched if nothing scripted it.
        const scripted = !!this.fallback || this.rules.some((r) => r.matches(ir));
        return { step: { kind: 'fault', fault: this.tagChaos(this.rng.pick(pool)) }, callIndex: 0, matchedBy: 'chaos', unmatched: !scripted, chaos: 'error' };
      }
      contentChaos = behaviour; // applied to the scripted reply once it's produced
    }
    const withChaos = <T extends object>(r: T) => (contentChaos ? { ...r, chaos: contentChaos } : r);

    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]!;
      if (rule.matches(ir)) {
        const taken = rule.take();
        // Rules for non-chat endpoints may only inject faults; normal replies use the built-in handler.
        if (ir.endpoint !== 'chat' && taken.step.kind !== 'fault') return { callIndex: 0, matchedBy: rule.name };
        return withChaos({ ...taken, rule, matchedBy: rule.name ?? `rule#${i + 1}` });
      }
    }
    if (ir.endpoint === 'chat' && this.fallback) return withChaos({ ...this.fallback.take(), rule: this.fallback, matchedBy: 'default' });
    // Only chat requests can be unmatched; models / count_tokens / embeddings have built-in answers.
    return withChaos({ callIndex: 0, unmatched: ir.endpoint === 'chat' });
  }

  /** Tag a chaos fault so the app-facing error says how to reproduce it. */
  private tagChaos(fault: Fault): Fault {
    const note = `[mock-llm chaos fault · seed ${this.seed} · reproduce with MOCK_LLM_SEED=${this.seed}]`;
    if (fault.type === 'error' || fault.type === 'stream_error') return { ...fault, error: { ...fault.error, note } };
    return fault;
  }

  /** The context window for a model: exact id first, then the longest matching glob. */
  private contextWindowFor(model: string): number | undefined {
    const windows = this.options.contextWindow;
    if (!windows) return undefined;
    if (windows[model] !== undefined) return windows[model];
    const globs = Object.keys(windows)
      .filter((k) => /[*?]/.test(k) && matchModel(k, model))
      .sort((a, b) => b.length - a.length);
    return globs.length ? windows[globs[0]!] : undefined;
  }

  /** Effective latency for one reply: step delay > rule latency > global latency (random delays sampled now). */
  private resolveLatency(rule: Rule | undefined, stepDelay: Delay | undefined, chunkIntervalMs?: number): AppliedLatency {
    const first = stepDelay ?? rule?.latency?.firstTokenMs ?? this.options.latency?.firstTokenMs;
    return {
      firstTokenMs: sampleDelay(first, this.latencyRng),
      tokensPerSec: rule?.latency?.tokensPerSec ?? this.options.latency?.tokensPerSec ?? 0,
      ...(chunkIntervalMs !== undefined && { chunkIntervalMs }),
    };
  }

  private async sendResponse(
    adapter: Adapter,
    ir: IRRequest,
    response: IRResponse,
    ctx: RenderContext,
    res: Res,
    finish: (status: number) => void,
    latency: AppliedLatency,
    cut?: { afterChunks: number; error?: ErrorSpec },
  ): Promise<void> {
    ctx.usage = computeUsage(ctx.usage.inputTokens, response);
    const { firstTokenMs, tokensPerSec } = latency;
    if (firstTokenMs) await sleep(firstTokenMs, res);

    if (!ir.stream) {
      if (tokensPerSec) await sleep((ctx.usage.outputTokens / tokensPerSec) * 1000, res);
      const reply = adapter.render(ir, response, ctx);
      finish(reply.status);
      if (cut) {
        // Non-streaming cut: send headers and half the body, then drop the socket.
        const body = JSON.stringify(reply.body);
        head(res, reply.status, { 'content-type': 'application/json', ...reply.headers });
        await write(res, body.slice(0, Math.floor(body.length / 2)));
        return kill(res);
      }
      return sendJson(res, reply);
    }

    const { contentType, headers, chunks } = adapter.stream(ir, response, ctx);
    head(res, 200, { 'content-type': contentType, 'cache-control': 'no-cache', ...(isH2(res) ? {} : { connection: 'keep-alive' }), ...headers });
    finish(200);
    const perChunkMs = latency.chunkIntervalMs ?? (tokensPerSec ? 1000 / tokensPerSec : 0);
    for (let i = 0; i < chunks.length; i++) {
      if (closed(res)) return;
      if (cut && i === cut.afterChunks) {
        if (cut.error) {
          // Like the real APIs, the error comes after a pause, so the client has consumed the earlier chunks first.
          // Without the pause, clients can see the last chunk and the error in one read: the Gemini SDK only
          // recognises its bare-JSON error when it fills a read on its own (Node ≤ 24's fetch merges reads).
          await sleep(STREAM_ERROR_GAP_MS, res);
          if (closed(res)) return;
          const frame = adapter.streamError(cut.error, ctx, ir, i);
          await write(res, frame);
          CHUNKS.get(res)?.(frame);
          return void res.end();
        }
        return kill(res);
      }
      if (perChunkMs && i > 0) await sleep(perChunkMs, res);
      await write(res, chunks[i]!);
      CHUNKS.get(res)?.(chunks[i]!);
    }
    res.end();
  }

  private async applyFault(
    fault: Fault,
    adapter: Adapter,
    ir: IRRequest,
    ctx: RenderContext,
    res: Res,
    finish: (status: number) => void,
    streamLatency: () => AppliedLatency,
  ): Promise<void> {
    switch (fault.type) {
      case 'error': {
        const reply = adapter.error(fault.error, ctx);
        finish(reply.status);
        return sendJson(res, reply);
      }
      case 'raw':
        finish(fault.status);
        head(res, fault.status, fault.headers);
        record(res, fault.body);
        return void res.end(fault.body);
      case 'connection_reset':
        finish(0);
        return kill(res);
      case 'timeout':
        finish(0);
        await sleep(fault.ms ?? Number.MAX_SAFE_INTEGER, res);
        return kill(res);
      case 'stream_cut':
      case 'stream_error': {
        if (fault.type === 'stream_error' && !ir.stream) {
          const reply = adapter.error(fault.error, ctx);
          finish(reply.status);
          return sendJson(res, reply);
        }
        const response = { content: [{ type: 'text' as const, text: LONG_STREAM_TEXT }], ...fault.response };
        // Partial streams honour rule/global latency (a fault has no step delay).
        return this.sendResponse(adapter, ir, response, ctx, res, finish, streamLatency(), {
          afterChunks: fault.afterChunks,
          error: fault.type === 'stream_error' ? fault.error : undefined,
        });
      }
    }
  }

  /**
   * HTTP control API for out-of-process tests (Playwright, child processes); see `RemoteMockLLM`.
   * Scripting uses the scenario-file format, since function responders can't cross processes.
   */
  private async control(method: string, path: string, req: Req, res: Res): Promise<void> {
    const ok = (body: unknown) => sendJson(res, { status: 200, body });
    if (method === 'GET' && path === '/__mock/info') {
      return ok({ urls: this.urls, strict: !!this.options.strict, pricing: this.pricing, seed: this.seed });
    }
    if (method === 'GET' && path === '/__mock/journal') return ok(this.journal.all());
    if (method === 'POST' && path === '/__mock/reset') {
      this.reset();
      return ok({ ok: true });
    }
    if (method === 'POST' && path === '/__mock/load') {
      try {
        await this.load(JSON.parse((await readBody(req)) || '{}') as ScenarioFile);
        return ok({ ok: true });
      } catch (err) {
        return sendJson(res, { status: 400, body: { error: { message: (err as Error).message } } });
      }
    }
    sendJson(res, { status: 404, body: { error: { message: `unknown mock-llm control endpoint: ${method} ${path}` } } });
  }
}

export interface MockUrls {
  base: string;
  openai: string;
  anthropic: string;
  gemini: string;
  bedrock: string;
}

/** `MOCK_LLM_SEED` (if set) overrides the configured seed; default 1. */
export function effectiveSeed(configured: number | undefined): number {
  const env = process.env.MOCK_LLM_SEED;
  if (env !== undefined && env.trim() !== '') {
    if (!/^-?\d+$/.test(env.trim())) throw new Error(`mock-llm: MOCK_LLM_SEED must be an integer, got ${JSON.stringify(env)}`);
    return Number(env.trim());
  }
  return configured ?? 1;
}

/** The SDK base URLs for a mock at `baseUrl`. Pure: usable before the mock starts (e.g. in playwright.config). */
export function urlsFor(baseUrl: string): MockUrls {
  const base = baseUrl.replace(/\/+$/, '');
  return { base, openai: `${base}/openai/v1`, anthropic: `${base}/anthropic`, gemini: `${base}/gemini`, bedrock: `${base}/bedrock` };
}

/** Env vars pointing every SDK at a mock at `baseUrl` (what `mock.env()` returns). */
export function envFor(baseUrl: string, apiKey = 'mock-llm-key'): Record<string, string> {
  const urls = urlsFor(baseUrl);
  return {
    OPENAI_BASE_URL: urls.openai,
    OPENAI_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: urls.anthropic,
    ANTHROPIC_API_KEY: apiKey,
    GOOGLE_GEMINI_BASE_URL: urls.gemini,
    GEMINI_API_KEY: apiKey,
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: urls.bedrock,
    AWS_ACCESS_KEY_ID: apiKey,
    AWS_SECRET_ACCESS_KEY: 'mock-llm-secret',
    AWS_REGION: 'us-east-1',
  };
}

/** Thrown by `assertExpectations()` when a scenario expectation failed. */
export class ExpectationError extends Error {
  override name = 'ExpectationError';
}

/** Run a step's expectations against the one request it answers, with the R2 assertion core. */
function checkExpectations(exp: NonNullable<Extract<Step, { kind: 'respond' }>['expect']>, entry: JournalEntry): JournalEntry['expectations'] {
  const target: AssertTarget = { all: () => [entry] };
  const out: NonNullable<JournalEntry['expectations']> = [];
  if (exp.toolResult) {
    const r = toHaveReturnedToolResult(target, exp.toolResult.name, exp.toolResult.content);
    out.push({ location: exp.location, kind: 'expectToolResult', pass: r.pass, message: r.message() });
  }
  if (exp.request) {
    const r = toHaveReceivedRequest(target, exp.request);
    out.push({ location: exp.location, kind: 'expectRequest', pass: r.pass, message: r.message() });
  }
  return out;
}

/** Thrown by `assertNoUnmatched()` when the app made LLM requests no rule scripted. */
export class UnmatchedRequestError extends Error {
  override name = 'UnmatchedRequestError';
}

/** Create and start a mock. Remember to `await mock.stop()`. */
export async function createMockLLM(options: MockLLMOptions = {}): Promise<MockLLM> {
  return new MockLLM(options).start();
}

const LONG_STREAM_TEXT =
  'This response is being streamed in many small pieces so that the connection can be interrupted partway through, the way real networks sometimes do.';

function resolveProvider(pathname: string, headers: Record<string, string>): { provider: Provider; path: string } | null {
  for (const p of Object.keys(ADAPTERS) as Provider[]) {
    if (pathname.startsWith(`/${p}/`)) return { provider: p, path: pathname.slice(p.length + 1) };
  }
  // Unprefixed paths, for clients configured with a bare host.
  if (pathname.startsWith('/model/')) return { provider: 'bedrock', path: pathname };
  if (/^\/v1(beta1?|alpha)?\/(projects\/|models\/[^/]+:)/.test(pathname) || pathname.startsWith('/v1beta/')) {
    return { provider: 'gemini', path: pathname };
  }
  if (pathname.startsWith('/v1/messages')) return { provider: 'anthropic', path: pathname };
  if (pathname.startsWith('/v1/models') && (headers['anthropic-version'] || headers['x-api-key'])) {
    return { provider: 'anthropic', path: pathname };
  }
  if (pathname.startsWith('/v1/')) return { provider: 'openai', path: pathname };
  return null;
}

/**
 * Parse with the adapter. A malformed body that trips the parser (e.g. `messages: [null]`) is a 400 the real
 * API would send, not a mock crash: an internal 500 would make the SDK retry and raise the wrong error class.
 */
function parseRequest(adapter: Adapter, endpoint: Endpoint, body: any, headers: Record<string, string>, path: string, state: Map<string, unknown>): IRRequest {
  try {
    return adapter.parse(endpoint, body, headers, path, state);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError({ kind: 'bad_request', message: `Invalid request body (mock-llm could not read it: ${(err as Error)?.message ?? err}).` });
  }
}

function computeUsage(inputTokens: number, response: IRResponse): IRUsage {
  return { inputTokens, outputTokens: contentTokens(response.content), ...response.usage };
}

function sendJson(res: Res, reply: HttpReply): void {
  if (closed(res)) return;
  head(res, reply.status, { 'content-type': 'application/json', ...reply.headers });
  const body = JSON.stringify(reply.body);
  record(res, body);
  res.end(body);
}

function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write and wait for the chunk to be flushed, so a later cut/destroy happens after it. */
function write(res: Res, chunk: string | Uint8Array): Promise<void> {
  record(res, chunk);
  return new Promise((resolve) => (closed(res) ? resolve() : (res as ServerResponse).write(chunk, () => resolve())));
}

/** Sleep, but wake early if the client goes away. */
function sleep(ms: number, res: Res): Promise<void> {
  return new Promise((resolve) => {
    if (closed(res)) return resolve();
    const timer = setTimeout(done, Math.min(ms, 2 ** 31 - 1));
    function done() {
      clearTimeout(timer);
      res.off('close', done);
      resolve();
    }
    res.on('close', done);
  });
}

/** writeHead for either protocol (HTTP/2 forbids connection-specific headers). */
function head(res: Res, status: number, headers: Record<string, string | undefined> = {}): void {
  const h = isH2(res) ? Object.fromEntries(Object.entries(headers).filter(([k]) => !['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase()))) : headers;
  const wire = WIRE.get(res);
  if (wire) {
    wire.status = status;
    wire.headers = Object.fromEntries(Object.entries(h).flatMap(([k, v]) => (v === undefined ? [] : [[k.toLowerCase(), v]])));
  }
  (res as ServerResponse).writeHead(status, h);
}

function isH2(res: Res): res is Http2ServerResponse {
  return 'stream' in res;
}

function closed(res: Res): boolean {
  return isH2(res) ? res.stream.destroyed || res.stream.closed : res.destroyed;
}

/** Abort abruptly: destroy the HTTP/1 socket, or reset the HTTP/2 stream. */
function kill(res: Res): void {
  const wire = WIRE.get(res);
  if (wire) wire.aborted = isH2(res) ? 'HTTP/2 stream reset (RST_STREAM INTERNAL_ERROR)' : 'connection destroyed';
  if (isH2(res)) res.stream.close(h2.NGHTTP2_INTERNAL_ERROR);
  else res.destroy();
}

function cap(text: string): { text: string; truncated: boolean } {
  return text.length > WIRE_LIMIT ? { text: text.slice(0, WIRE_LIMIT), truncated: true } : { text, truncated: false };
}

/** Readable text for a body chunk: strings as-is, AWS event-stream frames decoded. */
function chunkText(chunk: string | Uint8Array): string {
  if (typeof chunk === 'string') return chunk;
  try {
    const { headers, payload } = decodeMessage(chunk);
    const kind = headers[':event-type'] ?? headers[':exception-type'];
    let shown = payload;
    try {
      const bytes = JSON.parse(payload).bytes;
      if (typeof bytes === 'string') shown = `${payload}\n    ↳ bytes decoded: ${Buffer.from(bytes, 'base64').toString('utf8')}`;
    } catch {}
    return `[event-stream frame ${chunk.byteLength}B · ${headers[':message-type']}:${kind}] ${shown}\n`;
  } catch {
    return `[${chunk.byteLength} binary bytes]\n`;
  }
}

/** Append a body chunk to the wire log; binary event-stream frames are decoded for readability. */
function record(res: Res, chunk: string | Uint8Array): void {
  const wire = WIRE.get(res);
  if (!wire || wire.truncated) return;
  const next = cap(wire.body + chunkText(chunk));
  wire.body = next.text;
  if (next.truncated) wire.truncated = true;
}
