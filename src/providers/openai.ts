import { embedding, type Rng } from '../core/rng.js';
import { approxTokens, textPieces } from '../core/tokens.js';
import type { ErrorSpec, IRMessage, IRRequest, IRRequestPart, IRResponse, IRTool, StopReason } from '../core/types.js';
import {
  ApiError,
  defaultStopReason,
  pieces,
  requireField,
  retryHeaders,
  sse,
  toolInputString,
  type Adapter,
  type HttpReply,
  type RenderContext,
} from './adapter.js';
import { parseResponsesBody, renderResponses, responsesStreamError, streamResponses } from './openai-responses.js';

const RESPONSES = '/v1/responses';

/**
 * OpenAI Chat Completions wire format. Also the de-facto standard spoken by
 * xAI (Grok), Mistral, Groq, DeepSeek, Together, Ollama, vLLM, LM Studio, etc.
 */
export const openaiAdapter: Adapter = {
  provider: 'openai',

  route(method, path) {
    if (method === 'POST' && (path === '/v1/chat/completions' || path === RESPONSES)) return 'chat';
    if (method === 'POST' && path === '/v1/embeddings') return 'embeddings';
    if (method === 'GET' && (path === '/v1/models' || path.startsWith('/v1/models/'))) return 'models';
    return null;
  },

  apiKey(headers) {
    return headers['authorization']?.replace(/^Bearer\s+/i, '') || undefined;
  },

  parse(endpoint, body, headers, path, state) {
    const base: IRRequest = {
      provider: 'openai',
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
    requireField(typeof body?.model === 'string' && body.model.length > 0, "you must provide a model parameter");
    if (endpoint === 'embeddings') {
      requireField(body.input !== undefined, "'input' is a required property");
      return base;
    }
    if (path === RESPONSES) return parseResponsesBody(body, base, state);

    requireField(Array.isArray(body.messages), "'messages' is a required property");
    requireField(body.messages.length > 0, "Invalid 'messages': empty array. Expected an array with minimum length 1.");

    const system: string[] = [];
    const messages: IRMessage[] = [];
    for (const m of body.messages) {
      if (m.role === 'system' || m.role === 'developer') {
        system.push(textOf(m.content));
      } else if (m.role === 'user') {
        messages.push({ role: 'user', content: partsOf(m.content) });
      } else if (m.role === 'assistant') {
        const content = m.content == null ? [] : partsOf(m.content);
        for (const tc of m.tool_calls ?? []) {
          content.push({ type: 'tool_call', id: tc.id, name: tc.function?.name, input: tryJson(tc.function?.arguments) });
        }
        messages.push({ role: 'assistant', content });
      } else if (m.role === 'tool' || m.role === 'function') {
        messages.push({
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: m.tool_call_id ?? m.name ?? '', content: textOf(m.content) }],
        });
      } else {
        throw new ApiError({ kind: 'bad_request', message: `Invalid value: '${m.role}'. Supported values are: 'system', 'assistant', 'user', 'tool', 'function', and 'developer'.` });
      }
    }

    const tools: IRTool[] = (body.tools ?? [])
      .filter((t: any) => t?.type === 'function' || t?.function)
      .map((t: any) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));

    const rf = body.response_format;
    return {
      ...base,
      system: system.length ? system.join('\n\n') : undefined,
      messages,
      tools,
      toolChoice: body.tool_choice,
      responseFormat: rf?.type ? { type: rf.type, schema: rf.json_schema?.schema } : undefined,
      stream: body.stream === true,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      temperature: body.temperature,
    };
  },

  render(req, res, ctx) {
    if (req.path === RESPONSES) return { status: 200, headers: requestId(ctx), body: renderResponses(req, res, ctx) };
    const { text, toolCalls, finishReason, refusal } = assemble(res, ctx.rng);
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: refusal ? null : toolCalls.length && !text ? null : text,
      refusal: refusal ? text : null,
      annotations: [],
    };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      status: 200,
      headers: requestId(ctx),
      body: {
        id: `chatcmpl-${ctx.rng.id(29)}`,
        object: 'chat.completion',
        created: ctx.created,
        model: res.model ?? req.model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
        usage: usage(ctx),
        service_tier: 'default',
        system_fingerprint: 'fp_mockllm',
      },
    };
  },

  stream(req, res, ctx) {
    if (req.path === RESPONSES) {
      return { contentType: 'text/event-stream; charset=utf-8', headers: requestId(ctx), chunks: streamResponses(req, res, ctx) };
    }
    const { text, toolCalls, finishReason, refusal } = assemble(res, ctx.rng);
    const includeUsage = req.raw?.stream_options?.include_usage === true;
    const id = `chatcmpl-${ctx.rng.id(29)}`;
    const model = res.model ?? req.model;
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      sse({
        id,
        object: 'chat.completion.chunk',
        created: ctx.created,
        model,
        system_fingerprint: 'fp_mockllm',
        choices: [{ index: 0, delta, logprobs: null, finish_reason }],
        ...(includeUsage ? { usage: null } : {}),
      });

    const chunks: string[] = [chunk({ role: 'assistant', content: '', refusal: null })];
    if (text) {
      for (const piece of res.content.flatMap((c) => (c.type === 'text' ? textPieces(c) : []))) {
        chunks.push(chunk(refusal ? { refusal: piece } : { content: piece }));
      }
    }
    toolCalls.forEach((tc, index) => {
      chunks.push(chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
      for (const p of pieces(tc.function.arguments)) chunks.push(chunk({ tool_calls: [{ index, function: { arguments: p } }] }));
    });
    chunks.push(chunk({}, finishReason));
    if (includeUsage) {
      chunks.push(sse({ id, object: 'chat.completion.chunk', created: ctx.created, model, system_fingerprint: 'fp_mockllm', choices: [], usage: usage(ctx) }));
    }
    chunks.push(sse('[DONE]'));
    return { contentType: 'text/event-stream; charset=utf-8', headers: requestId(ctx), chunks };
  },

  streamError(error, _ctx, req) {
    if (req?.path === RESPONSES) return responsesStreamError(envelope(error).error);
    return sse({ error: envelope(error).error });
  },

  error(error, ctx) {
    const { status, error: body } = envelope(error);
    return {
      status: error.status ?? status,
      headers: { ...requestId(ctx), ...retryHeaders(error), ...rateLimitHeaders(error), ...error.headers },
      body: { error: body },
    };
  },

  other(req, ctx) {
    if (req.endpoint === 'models') {
      const model = (id: string) => ({ id, object: 'model', created: 1700000000, owned_by: 'mock-llm' });
      if (req.model) {
        if (!ctx.models.includes(req.model)) throw new ApiError({ kind: 'not_found', message: `The model '${req.model}' does not exist` });
        return { status: 200, headers: requestId(ctx), body: model(req.model) };
      }
      return { status: 200, headers: requestId(ctx), body: { object: 'list', data: ctx.models.map(model) } };
    }
    // embeddings: deterministic per input text, unit length
    const raw = req.raw.input;
    const inputs: string[] = (Array.isArray(raw) ? raw : [raw]).map((x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const dims: number = req.raw.dimensions ?? 1536;
    const base64 = req.raw.encoding_format === 'base64';
    const data = inputs.map((input, index) => {
      const vec = embedding(input, dims);
      return {
        object: 'embedding',
        index,
        embedding: base64 ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64') : Array.from(vec),
      };
    });
    const tokens = inputs.reduce((n, s) => n + approxTokens(s), 0);
    return {
      status: 200,
      headers: requestId(ctx),
      body: { object: 'list', data, model: req.model, usage: { prompt_tokens: tokens, total_tokens: tokens } },
    };
  },
};

function assemble(res: IRResponse, rng: Rng) {
  const text = res.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');
  const toolCalls = res.content.flatMap((c) =>
    c.type === 'tool_call'
      ? [{ id: c.id ?? `call_${rng.id(24)}`, type: 'function' as const, function: { name: c.name, arguments: toolInputString(c.input) } }]
      : [],
  );
  const stop = defaultStopReason(res);
  return { text, toolCalls, finishReason: FINISH[stop], refusal: stop === 'refusal' };
}

const FINISH: Record<StopReason, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  refusal: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  content_filter: 'content_filter',
};

function usage(ctx: RenderContext) {
  const { inputTokens, outputTokens, cacheReadInputTokens = 0 } = ctx.usage;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cacheReadInputTokens, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  };
}

function envelope(e: ErrorSpec): { status: number; error: { message: string; type: string; param: string | null; code: string | null } } {
  const make = (status: number, type: string, code: string | null, message: string, param: string | null = null) => ({
    status,
    error: { message: `${e.message ?? message}${e.note ? ` ${e.note}` : ''}`, type, param, code },
  });
  switch (e.kind) {
    case 'bad_request':
      return make(400, 'invalid_request_error', null, 'Invalid request.');
    case 'auth':
      return make(401, 'invalid_request_error', 'invalid_api_key', 'Incorrect API key provided: sk-mock***. You can find your API key at https://platform.openai.com/account/api-keys.');
    case 'permission':
      return make(403, 'invalid_request_error', 'permission_denied', 'You are not allowed to access this resource.');
    case 'not_found':
      return make(404, 'invalid_request_error', 'model_not_found', 'The model does not exist or you do not have access to it.');
    case 'context_length':
      return make(
        400,
        'invalid_request_error',
        'context_length_exceeded',
        `This model's maximum context length is ${e.details?.limit ?? 128000} tokens. However, your messages resulted in ${e.details?.inputTokens ?? 131072} tokens. Please reduce the length of the messages.`,
        'messages',
      );
    case 'request_too_large':
      return make(413, 'invalid_request_error', 'request_too_large', 'Request too large.');
    case 'rate_limit':
      return make(429, 'requests', 'rate_limit_exceeded', 'Rate limit reached for requests. Please try again later.');
    case 'server':
      return make(500, 'server_error', null, 'The server had an error while processing your request. Sorry about that!');
    case 'overloaded':
      return make(503, 'server_error', null, 'The engine is currently overloaded, please try again later.');
  }
}

function rateLimitHeaders(e: ErrorSpec): Record<string, string> {
  return e.kind === 'rate_limit' ? { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': `${e.retryAfter ?? 1}s` } : {};
}

function requestId(ctx: RenderContext): Record<string, string> {
  return { 'x-request-id': `req_${ctx.rng.id(32)}`, 'openai-processing-ms': '1' };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

function partsOf(content: unknown): IRRequestPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((p: any): IRRequestPart => (p?.type === 'text' ? { type: 'text', text: p.text ?? '' } : { type: 'image' }));
}

function tryJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
