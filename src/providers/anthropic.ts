import { chunkText, textPieces } from '../core/tokens.js';
import type { ErrorSpec, IRContent, IRMessage, IRRequest, IRRequestPart, IRResponse, IRTool, StopReason } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { capabilitiesOf, type ModelCapabilities, type ModelLifecycle } from '../core/models.js';
import {
  ApiError,
  defaultStopReason,
  pieces,
  requireField,
  retryHeaders,
  sse,
  toolInputString,
  type Adapter,
  type RenderContext,
} from './adapter.js';

/**
 * Anthropic Messages API (Claude). Claude Code and the Claude Agent SDK speak
 * this too, via `ANTHROPIC_BASE_URL`.
 */
export const anthropicAdapter: Adapter = {
  provider: 'anthropic',

  route(method, path) {
    if (method === 'POST' && path === '/v1/messages') return 'chat';
    if (method === 'POST' && path === '/v1/messages/count_tokens') return 'count_tokens';
    if (method === 'GET' && (path === '/v1/models' || path.startsWith('/v1/models/'))) return 'models';
    return null;
  },

  apiKey(headers) {
    return headers['x-api-key'] || headers['authorization']?.replace(/^Bearer\s+/i, '') || undefined;
  },

  parse(endpoint, body, headers, path) {
    const base: IRRequest = {
      provider: 'anthropic',
      endpoint,
      path,
      model: typeof body?.model === 'string' ? body.model : '',
      messages: [],
      tools: [],
      stream: false,
      headers,
      raw: body,
    };
    if (endpoint === 'models') {
      base.model = decodeURIComponent(path.slice('/v1/models/'.length));
      return base;
    }
    requireField(typeof body?.model === 'string' && body.model.length > 0, 'model: Field required');
    return parseAnthropicBody(body, base, { requireMaxTokens: endpoint === 'chat' });
  },

  validate(req, ctx) {
    if (req.endpoint !== 'chat') return;
    // Anthropic documents only that requests to a retired model fail. 404 not_found_error (the mock's unknown-model
    // answer) is unverified: see ModelSpec.lifecycle.
    if (ctx.modelSpec(req.model)?.lifecycle === 'retired') throw new ApiError({ kind: 'not_found', message: `model: ${req.model}` });
    validateAnthropicThinking(req, ctx);
  },

  shapeResponse: shapeAnthropicThinking,

  render(req, res, ctx) {
    return { status: 200, headers: requestId(ctx), body: anthropicMessage(req, res, ctx) };
  },

  stream(req, res, ctx) {
    const chunks = anthropicStreamEvents(req, res, ctx).map((e) => sse(e, e.type as string));
    return { contentType: 'text/event-stream; charset=utf-8', headers: requestId(ctx), chunks };
  },

  streamError(error) {
    return sse({ type: 'error', error: envelope(error).error }, 'error');
  },

  error(error, ctx) {
    const { status, error: body } = envelope(error);
    const id = requestId(ctx);
    return {
      status: error.status ?? status,
      headers: { ...id, ...retryHeaders(error), ...error.headers },
      body: { type: 'error', error: body, request_id: id['request-id'] },
    };
  },

  other(req, ctx) {
    if (req.endpoint === 'count_tokens') {
      return { status: 200, headers: requestId(ctx), body: { input_tokens: ctx.usage.inputTokens } };
    }
    if (req.model) {
      if (!ctx.models.includes(req.model)) throw new ApiError({ kind: 'not_found', message: `model: ${req.model}` });
      return { status: 200, headers: requestId(ctx), body: modelInfo(req.model, ctx) }; // retired models stay retrievable
    }
    // `lifecycle[]=…` (the SDK's query format). Omitted: active and deprecated; retired only when asked for.
    const wanted = [...ctx.query.getAll('lifecycle[]'), ...ctx.query.getAll('lifecycle')];
    const bad = wanted.findIndex((l) => !LIFECYCLES.includes(l as ModelLifecycle));
    if (bad !== -1) throw new ApiError({ kind: 'bad_request', message: `lifecycle.${bad}: Input should be 'active', 'deprecated' or 'retired'` });
    const stages = wanted.length ? wanted : ['active', 'deprecated'];
    const data = ctx.models.map((id) => modelInfo(id, ctx)).filter((m) => stages.includes(m.lifecycle));
    return {
      status: 200,
      headers: requestId(ctx),
      body: { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null },
    };
  },
};

const LIFECYCLES: ModelLifecycle[] = ['active', 'deprecated', 'retired'];

/**
 * A Models API object. SDK ≥ 1.0 (API 2026-10-21) types `capabilities`, `lifecycle`, `line`, `deprecated_at` and
 * `retires_at` as always present; the `models` option's ModelSpec sets them (default: active, every capability).
 */
function modelInfo(id: string, ctx: RenderContext) {
  const spec = ctx.modelSpec(id);
  const lifecycle: ModelLifecycle = spec?.lifecycle ?? 'active';
  return {
    type: 'model',
    id,
    display_name: spec?.displayName ?? id,
    created_at: '2025-01-01T00:00:00Z',
    capabilities: capabilitiesOf(spec),
    lifecycle,
    line: spec?.line !== undefined ? spec.line : modelLine(id),
    deprecated_at: spec?.deprecatedAt ?? (lifecycle === 'active' ? null : '2025-01-01T00:00:00Z'),
    retires_at: spec?.retiresAt ?? null,
    max_input_tokens: null,
    max_tokens: null,
  };
}

/** Parse an Anthropic Messages body (also used for Claude on Bedrock InvokeModel). */
export function parseAnthropicBody(body: any, base: IRRequest, opts: { requireMaxTokens: boolean }): IRRequest {
  requireField(Array.isArray(body.messages), 'messages: Field required');
  if (opts.requireMaxTokens) requireField(typeof body.max_tokens === 'number', 'max_tokens: Field required');

  const system: string[] = [];
  if (typeof body.system === 'string') system.push(body.system);
  else if (Array.isArray(body.system)) system.push(body.system.map((b: any) => b.text ?? '').join('\n\n'));

  const messages: IRMessage[] = [];
  body.messages.forEach((m: any, i: number) => {
    if (m?.role === 'system') {
      // Mid-conversation system messages (sent by e.g. Claude Code) fold into the system prompt.
      const text = blocksOf(m.content).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
      if (text) system.push(text);
      return;
    }
    if (m?.role !== 'user' && m?.role !== 'assistant') {
      throw new ApiError({ kind: 'bad_request', message: `messages.${i}.role: Input should be 'user', 'assistant' or 'system'` });
    }
    messages.push({ role: m.role, content: blocksOf(m.content) });
  });

  const tools: IRTool[] = (body.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));

  const format = body.output_config?.format ?? body.output_format;
  return {
    ...base,
    system: system.length ? system.join('\n\n') : undefined,
    messages,
    tools,
    toolChoice: body.tool_choice,
    responseFormat: format?.type === 'json_schema' ? { type: 'json_schema', schema: format.schema } : undefined,
    stream: body.stream === true,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    speed: body.speed === 'fast' || body.speed === 'standard' ? body.speed : undefined,
  };
}

const THINKING_TYPES = ['adaptive', 'enabled', 'disabled', 'between_tools'] as const;
type ThinkingType = (typeof THINKING_TYPES)[number];

/**
 * The `thinking` config checks from Anthropic's docs (api/errors, build-with-claude/thinking): `between_tools` takes no
 * other field and `display` is invalid with `disabled` (status and type documented; the message is the mock's), and a
 * type the model's `capabilities` mark unsupported gets the documented 400 message. Capabilities come from the
 * `models` option and default to everything supported, so nothing is rejected on model grounds unless a test says so.
 */
export function validateAnthropicThinking(req: IRRequest, ctx: RenderContext): void {
  const thinking = req.raw?.thinking;
  if (thinking == null) return;
  const type = thinking.type as ThinkingType;
  if (!THINKING_TYPES.includes(type)) {
    throw new ApiError({ kind: 'bad_request', message: `thinking.type: Input should be 'adaptive', 'enabled', 'disabled' or 'between_tools'` });
  }
  const extra = Object.keys(thinking).find((k) => k !== 'type');
  if (type === 'between_tools' && extra) throw new ApiError({ kind: 'bad_request', message: `thinking.${extra}: Extra inputs are not permitted` });
  if (type === 'disabled' && 'display' in thinking) throw new ApiError({ kind: 'bad_request', message: 'thinking.display: Extra inputs are not permitted' });
  const types = capabilitiesOf(ctx.modelSpec(req.model)).thinking.types;
  if (!types[type].supported) throw new ApiError({ kind: 'bad_request', message: thinkingNotSupported(type, types) });
}

/** The API's 400 message for a thinking type the model rejects (verbatim from platform.claude.com/docs/en/api/errors). */
function thinkingNotSupported(type: ThinkingType, types: ModelCapabilities['thinking']['types']): string {
  const useAdaptive = 'Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  switch (type) {
    case 'adaptive':
      return 'adaptive thinking is not supported on this model';
    case 'enabled':
      return `"thinking.type.enabled" is not supported for this model. ${useAdaptive}`;
    case 'between_tools':
      return '"thinking.type.between_tools" is not supported for this model.';
    case 'disabled':
      if (types.between_tools.supported) {
        return 'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}. The model does not think before responding. The short updates it writes between tool calls come back as thinking blocks.';
      }
      if (types.enabled.supported) {
        return '"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode when not specified; use "thinking.type.enabled" with "budget_tokens" for extended thinking.';
      }
      return `"thinking.type.disabled" is not supported for this model. ${useAdaptive}`;
  }
}

/**
 * Thinking blocks the request's `thinking` config allows. `disabled`: none. `between_tools`: no up-front thinking;
 * a scripted thinking block comes back only as a progress update, moved to sit directly before the tool call it
 * introduces (at most one per call), so a reply without tool calls is text only. Other configs: unchanged.
 */
export function shapeAnthropicThinking(req: IRRequest, res: IRResponse): IRResponse {
  const type = req.raw?.thinking?.type;
  if ((type !== 'disabled' && type !== 'between_tools') || !res.content.some((c) => c.type === 'thinking')) return res;
  if (type === 'disabled') return { ...res, content: res.content.filter((c) => c.type !== 'thinking') };
  const content: IRContent[] = [];
  let update: IRContent | undefined;
  for (const c of res.content) {
    if (c.type === 'thinking') update = c;
    else {
      if (c.type === 'tool_call' && update) content.push(update);
      if (c.type === 'tool_call') update = undefined;
      content.push(c);
    }
  }
  return { ...res, content };
}

/** Non-streaming Messages response body. */
export function anthropicMessage(req: IRRequest, res: IRResponse, ctx: RenderContext): Record<string, unknown> {
  const stop = defaultStopReason(res);
  return {
    id: `msg_${ctx.rng.id(24)}`,
    type: 'message',
    role: 'assistant',
    model: res.model ?? req.model,
    content: res.content.map((c) => block(c, ctx.rng, false)),
    stop_reason: STOP[stop],
    stop_sequence: null,
    stop_details: stopDetails(stop, res),
    usage: usage(req, ctx),
  };
}

/** Streaming Messages events, in order, as plain objects (each has `type`). */
export function anthropicStreamEvents(req: IRRequest, res: IRResponse, ctx: RenderContext): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const ev = (type: string, data: Record<string, unknown>) => events.push({ type, ...data });
  const stop = defaultStopReason(res);

  ev('message_start', {
    message: {
      id: `msg_${ctx.rng.id(24)}`,
      type: 'message',
      role: 'assistant',
      model: res.model ?? req.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage(req, ctx), output_tokens: 1 },
    },
  });
  res.content.forEach((c, index) => {
    ev('content_block_start', { index, content_block: block(c, ctx.rng, true) });
    if (index === 0) ev('ping', {});
    if (c.type === 'text') {
      for (const text of textPieces(c)) ev('content_block_delta', { index, delta: { type: 'text_delta', text } });
    } else if (c.type === 'thinking') {
      for (const thinking of chunkText(c.text)) ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: signature(ctx.rng) } });
    } else {
      for (const partial_json of pieces(toolInputString(c.input))) {
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } });
      }
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', {
    delta: { stop_reason: STOP[stop], stop_sequence: null, stop_details: stopDetails(stop, res) },
    usage: { output_tokens: ctx.usage.outputTokens },
  });
  ev('message_stop', {});
  return events;
}

function stopDetails(stop: StopReason, res: IRResponse): Record<string, unknown> | null {
  if (stop !== 'refusal' && stop !== 'content_filter') return null;
  const text = res.content.find((c) => c.type === 'text') as { text: string } | undefined;
  return { type: 'refusal', category: null, explanation: text?.text || null };
}

const STOP: Record<StopReason, string> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  tool_use: 'tool_use',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
  content_filter: 'refusal',
};

function block(c: IRContent, rng: Rng, streaming: boolean): Record<string, unknown> {
  if (c.type === 'text') return { type: 'text', text: streaming ? '' : c.text };
  if (c.type === 'thinking') return streaming ? { type: 'thinking', thinking: '' } : { type: 'thinking', thinking: c.text, signature: signature(rng) };
  let input: unknown = c.input ?? {};
  if (typeof input === 'string') {
    // Non-streaming Claude always returns an object; malformed-args strings are passed through
    // verbatim so apps can be tested against it anyway.
    try {
      input = JSON.parse(input);
    } catch {}
  }
  return { type: 'tool_use', id: c.id ?? `toolu_${rng.id(24)}`, name: c.name, input: streaming ? {} : input };
}

/** A Claude model line (`opus`, `sonnet`, …) from a first-party id like claude-opus-5-5; null for anything else. */
function modelLine(id: string): string | null {
  if (!id.startsWith('claude-')) return null;
  return ['haiku', 'sonnet', 'opus', 'fable', 'mythos'].find((line) => id.split('-').includes(line)) ?? null;
}

function usage(req: IRRequest, ctx: RenderContext) {
  return {
    input_tokens: ctx.usage.inputTokens,
    output_tokens: ctx.usage.outputTokens,
    cache_creation_input_tokens: ctx.usage.cacheCreationInputTokens ?? 0,
    cache_read_input_tokens: ctx.usage.cacheReadInputTokens ?? 0,
    service_tier: 'standard',
    // The speed mode the request ran in. SDK ≥ 1.0 types it as always present on first-party usage; not sent on
    // Bedrock, whose Claude bodies don't document it.
    ...(req.provider === 'anthropic' && { speed: req.speed ?? 'standard' }),
  };
}

function signature(rng: Rng): string {
  return Buffer.from(`mock-llm-signature-${rng.id(32)}`).toString('base64');
}

function envelope(e: ErrorSpec): { status: number; error: { type: string; message: string } } {
  const make = (status: number, type: string, message: string) => ({ status, error: { type, message: `${e.message ?? message}${e.note ? ` ${e.note}` : ''}` } });
  switch (e.kind) {
    case 'bad_request':
      return make(400, 'invalid_request_error', 'Invalid request.');
    case 'auth':
      return make(401, 'authentication_error', 'invalid x-api-key');
    case 'permission':
      return make(403, 'permission_error', 'Your API key does not have permission to use the specified resource.');
    case 'not_found':
      return make(404, 'not_found_error', 'The requested resource could not be found.');
    case 'context_length':
      return make(400, 'invalid_request_error', `prompt is too long: ${e.details?.inputTokens ?? 210000} tokens > ${e.details?.limit ?? 200000} maximum`);
    case 'request_too_large':
      return make(413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.');
    case 'rate_limit':
      return make(429, 'rate_limit_error', 'This request would exceed the rate limit for your organization. Please try again later.');
    case 'server':
      return make(500, 'api_error', 'Internal server error');
    case 'overloaded':
      return make(529, 'overloaded_error', 'Overloaded');
  }
}

function requestId(ctx: RenderContext): Record<string, string> {
  return { 'request-id': `req_${ctx.rng.id(24)}` };
}

function blocksOf(content: unknown): IRRequestPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((b: any): IRRequestPart => {
    switch (b?.type) {
      case 'text':
        return { type: 'text', text: b.text ?? '' };
      case 'tool_use':
      case 'server_tool_use':
        return { type: 'tool_call', id: b.id, name: b.name, input: b.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          toolCallId: b.tool_use_id,
          isError: b.is_error,
          content: typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join(''),
        };
      case 'thinking':
        return { type: 'thinking', text: b.thinking ?? '' };
      default:
        return { type: 'image' };
    }
  });
}

