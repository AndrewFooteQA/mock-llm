import { embedding } from '../core/rng.js';
import { approxTokens, chunkText, textPieces } from '../core/tokens.js';
import type { ErrorKind, ErrorSpec, IRContent, IRMessage, IRRequest, IRRequestPart, IRResponse, IRTool, StopReason } from '../core/types.js';
import { ApiError, defaultStopReason, pieces, requireField, retryHeaders, toolInputString, type Adapter, type RenderContext } from './adapter.js';
import { anthropicMessage, anthropicStreamEvents, parseAnthropicBody } from './anthropic.js';
import { eventFrame, exceptionFrame } from './eventstream.js';

/**
 * Amazon Bedrock Runtime: Converse / ConverseStream (model-neutral) and
 * InvokeModel / InvokeModelWithResponseStream (model-native bodies for
 * Anthropic Claude, Amazon Nova, Meta Llama, Titan / Cohere embeddings).
 * SigV4 signatures are accepted without verification.
 */

const PATH = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream|converse|converse-stream|count-tokens)$/;

type Family = 'anthropic' | 'nova' | 'llama' | 'titan-embed' | 'cohere-embed' | 'converse';

function familyOf(modelId: string): Family | null {
  if (/anthropic\./.test(modelId)) return 'anthropic';
  if (/amazon\.nova/.test(modelId)) return 'nova';
  if (/meta\.llama/.test(modelId)) return 'llama';
  if (/amazon\.titan-embed/.test(modelId)) return 'titan-embed';
  if (/cohere\.embed/.test(modelId)) return 'cohere-embed';
  return null;
}

/** Which wire shape a request uses, derived from its path + model id. */
function shapeOf(req: IRRequest): Family {
  const op = req.path.match(PATH)?.[2] ?? '';
  return op.startsWith('converse') ? 'converse' : (familyOf(req.model) ?? 'converse');
}

export const bedrockAdapter: Adapter = {
  provider: 'bedrock',

  route(method, path) {
    const m = path.match(PATH);
    if (method !== 'POST' || !m) return null;
    if (m[2] === 'count-tokens') return 'count_tokens';
    const family = familyOf(decodeURIComponent(m[1]!));
    if ((m[2] === 'invoke' || m[2] === 'invoke-with-response-stream') && (family === 'titan-embed' || family === 'cohere-embed')) return 'embeddings';
    return 'chat';
  },

  apiKey(headers) {
    const auth = headers['authorization'] ?? '';
    return auth.match(/Credential=([^/,\s]+)/)?.[1] ?? (auth.replace(/^Bearer\s+/i, '') || undefined);
  },

  parse(endpoint, body, headers, path) {
    const [, rawId, op] = path.match(PATH)!;
    const model = decodeURIComponent(rawId!);
    const base: IRRequest = { provider: 'bedrock', endpoint, path, model, messages: [], tools: [], stream: false, headers, raw: body };
    const stream = op === 'converse-stream' || op === 'invoke-with-response-stream';

    if (endpoint === 'embeddings') return base;
    if (endpoint === 'count_tokens') {
      if (body?.input?.converse) return parseConverse(body.input.converse, base);
      const inner = body?.input?.invokeModel?.body;
      requireField(inner !== undefined, 'Either input.converse or input.invokeModel must be provided.');
      return parseInvoke(typeof inner === 'string' ? invokeBodyJson(inner) : inner, base);
    }
    const req = op!.startsWith('converse') ? parseConverse(body, base) : parseInvoke(body, base);
    return { ...req, stream };
  },

  render(req, res, ctx) {
    const shape = shapeOf(req);
    const headers = { ...requestId(ctx), ...usageHeaders(ctx) };
    if (shape === 'anthropic') return { status: 200, headers, body: anthropicMessage(req, res, ctx) };
    if (shape === 'llama') return { status: 200, headers, body: llamaBody(res, ctx) };
    return { status: 200, headers, body: converseBody(res, ctx) }; // converse + nova share a shape
  },

  stream(req, res, ctx) {
    const shape = shapeOf(req);
    let frames: Uint8Array[];
    if (shape === 'converse') {
      frames = converseEvents(res, ctx).map(([type, payload]) => eventFrame(type, payload));
    } else {
      let events: Array<Record<string, unknown>>;
      if (shape === 'anthropic') events = anthropicStreamEvents(req, res, ctx).filter((e) => e.type !== 'ping');
      else if (shape === 'llama') events = llamaEvents(res, ctx);
      else events = converseEvents(res, ctx).map(([type, payload]) => ({ [type]: payload }));
      const last = events.at(-1)!;
      last['amazon-bedrock-invocationMetrics'] = {
        inputTokenCount: ctx.usage.inputTokens,
        outputTokenCount: ctx.usage.outputTokens,
        invocationLatency: 1,
        firstByteLatency: 1,
      };
      frames = events.map((e) => eventFrame('chunk', { bytes: Buffer.from(JSON.stringify(e)).toString('base64') }));
    }
    return { contentType: 'application/vnd.amazon.eventstream', headers: requestId(ctx), chunks: frames };
  },

  streamError(error) {
    return exceptionFrame(STREAM_EXCEPTION[error.kind], `${error.message ?? envelope(error).message}${error.note ? ` ${error.note}` : ''}`);
  },

  error(error, ctx) {
    const { status, name, message } = envelope(error);
    return {
      status: error.status ?? status,
      headers: {
        ...requestId(ctx),
        'x-amzn-errortype': `${name}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
        ...retryHeaders(error),
        ...error.headers,
      },
      body: { message: `${error.message ?? message}${error.note ? ` ${error.note}` : ''}` },
    };
  },

  other(req, ctx) {
    if (req.endpoint === 'count_tokens') return { status: 200, headers: requestId(ctx), body: { inputTokens: ctx.usage.inputTokens } };
    // embeddings
    const family = familyOf(req.model);
    if (family === 'cohere-embed') {
      const texts: string[] = req.raw?.texts ?? [];
      return {
        status: 200,
        headers: requestId(ctx),
        body: { id: ctx.rng.id(36), response_type: 'embeddings_floats', texts, embeddings: texts.map((t) => Array.from(embedding(t, 1024))) },
      };
    }
    requireField(typeof req.raw?.inputText === 'string', 'Malformed input request: #: required key [inputText] not found, please reformat your input and try again.');
    const text: string = req.raw.inputText;
    return {
      status: 200,
      headers: requestId(ctx),
      body: { embedding: Array.from(embedding(text, req.raw.dimensions ?? 1024)), inputTextTokenCount: approxTokens(text) },
    };
  },
};

// ----------------------------------------------------------------- requests

function parseConverse(body: any, base: IRRequest): IRRequest {
  requireField(Array.isArray(body?.messages), '1 validation error detected: Value null at \'messages\' failed to satisfy constraint: Member must not be null');
  const messages: IRMessage[] = body.messages.map((m: any) => {
    const content: IRRequestPart[] = (m.content ?? []).map((b: any): IRRequestPart => {
      if (typeof b.text === 'string') return { type: 'text', text: b.text };
      if (b.toolUse) return { type: 'tool_call', id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input };
      if (b.toolResult) {
        const text = (b.toolResult.content ?? []).map((c: any) => (c.text ?? (c.json !== undefined ? JSON.stringify(c.json) : ''))).join('');
        return { type: 'tool_result', toolCallId: b.toolResult.toolUseId, content: text, isError: b.toolResult.status === 'error' };
      }
      if (b.reasoningContent) return { type: 'thinking', text: b.reasoningContent.reasoningText?.text ?? '' };
      return { type: 'image' };
    });
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
  });
  const tools: IRTool[] = (body.toolConfig?.tools ?? [])
    .filter((t: any) => t.toolSpec)
    .map((t: any) => ({ name: t.toolSpec.name, description: t.toolSpec.description, inputSchema: t.toolSpec.inputSchema?.json }));
  const system = (body.system ?? []).map((s: any) => s.text ?? '').filter(Boolean).join('\n\n');
  const ic = body.inferenceConfig ?? {};
  return {
    ...base,
    system: system || undefined,
    messages,
    tools,
    toolChoice: body.toolConfig?.toolChoice,
    maxTokens: ic.maxTokens ?? ic.max_new_tokens,
    temperature: ic.temperature,
  };
}

function parseInvoke(body: any, base: IRRequest): IRRequest {
  const family = familyOf(base.model);
  if (family === 'anthropic') {
    requireField(typeof body?.anthropic_version === 'string', 'Malformed input request: #: required key [anthropic_version] not found, please reformat your input and try again.');
    return parseAnthropicBody(body, base, { requireMaxTokens: true });
  }
  if (family === 'nova') return parseConverse(body, base);
  if (family === 'llama') {
    requireField(typeof body?.prompt === 'string', 'Malformed input request: #: required key [prompt] not found, please reformat your input and try again.');
    return { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: llamaUserText(body.prompt) }] }], maxTokens: body.max_gen_len, temperature: body.temperature };
  }
  throw new ApiError({
    kind: 'bad_request',
    message: `mock-llm: InvokeModel body format for '${base.model}' is not simulated; use the Converse API or an anthropic./amazon.nova/meta.llama model id.`,
  });
}

/** Pull the last user turn out of a Llama 3 chat-template prompt (or use the raw prompt). */
function llamaUserText(prompt: string): string {
  const parts = prompt.split('<|start_header_id|>user<|end_header_id|>');
  if (parts.length < 2) return prompt;
  return parts.at(-1)!.split('<|eot_id|>')[0]!.trim();
}

// ---------------------------------------------------------------- responses

const CONVERSE_STOP: Record<StopReason, string> = {
  end_turn: 'end_turn',
  refusal: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  content_filter: 'content_filtered',
};

function withIds(res: IRResponse, ctx: RenderContext): IRContent[] {
  return res.content.map((c) => (c.type === 'tool_call' && !c.id ? { ...c, id: `tooluse_${ctx.rng.id(22)}` } : c));
}

function converseBody(res: IRResponse, ctx: RenderContext) {
  const content = withIds(res, ctx).map((c) =>
    c.type === 'text'
      ? { text: c.text }
      : c.type === 'thinking'
        ? { reasoningContent: { reasoningText: { text: c.text, signature: ctx.rng.id(32) } } }
        : { toolUse: { toolUseId: c.id, name: c.name, input: c.input ?? {} } },
  );
  return {
    output: { message: { role: 'assistant', content } },
    stopReason: CONVERSE_STOP[defaultStopReason(res)],
    usage: converseUsage(ctx),
    metrics: { latencyMs: 1 },
  };
}

function converseEvents(res: IRResponse, ctx: RenderContext): Array<[string, Record<string, unknown>]> {
  const events: Array<[string, Record<string, unknown>]> = [['messageStart', { role: 'assistant' }]];
  withIds(res, ctx).forEach((c, contentBlockIndex) => {
    if (c.type === 'tool_call') {
      events.push(['contentBlockStart', { contentBlockIndex, start: { toolUse: { toolUseId: c.id, name: c.name } } }]);
      for (const input of pieces(toolInputString(c.input))) events.push(['contentBlockDelta', { contentBlockIndex, delta: { toolUse: { input } } }]);
    } else if (c.type === 'thinking') {
      for (const text of chunkText(c.text)) events.push(['contentBlockDelta', { contentBlockIndex, delta: { reasoningContent: { text } } }]);
      events.push(['contentBlockDelta', { contentBlockIndex, delta: { reasoningContent: { signature: ctx.rng.id(32) } } }]);
    } else {
      for (const text of textPieces(c)) events.push(['contentBlockDelta', { contentBlockIndex, delta: { text } }]);
    }
    events.push(['contentBlockStop', { contentBlockIndex }]);
  });
  events.push(['messageStop', { stopReason: CONVERSE_STOP[defaultStopReason(res)] }]);
  events.push(['metadata', { usage: converseUsage(ctx), metrics: { latencyMs: 1 } }]);
  return events;
}

function converseUsage(ctx: RenderContext) {
  const { inputTokens, outputTokens } = ctx.usage;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function llamaText(res: IRResponse): string {
  return res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
}

function llamaBody(res: IRResponse, ctx: RenderContext) {
  return {
    generation: llamaText(res),
    prompt_token_count: ctx.usage.inputTokens,
    generation_token_count: ctx.usage.outputTokens,
    stop_reason: defaultStopReason(res) === 'max_tokens' ? 'length' : 'stop',
  };
}

function llamaEvents(res: IRResponse, ctx: RenderContext): Array<Record<string, unknown>> {
  const parts = res.content.flatMap((c) => (c.type === 'text' ? textPieces(c) : []));
  if (!parts.length) parts.push('');
  return parts.map((generation, i) => ({
    generation,
    prompt_token_count: i === 0 ? ctx.usage.inputTokens : null,
    generation_token_count: i + 1,
    stop_reason: i === parts.length - 1 ? (defaultStopReason(res) === 'max_tokens' ? 'length' : 'stop') : null,
  }));
}

// ------------------------------------------------------------------- errors

function envelope(e: ErrorSpec): { status: number; name: string; message: string } {
  switch (e.kind) {
    case 'bad_request':
      return { status: 400, name: 'ValidationException', message: 'Malformed input request, please reformat your input and try again.' };
    case 'auth':
      return { status: 403, name: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' };
    case 'permission':
      return { status: 403, name: 'AccessDeniedException', message: "You don't have access to the model with the specified model ID." };
    case 'not_found':
      return { status: 404, name: 'ResourceNotFoundException', message: 'The provided model identifier is invalid.' };
    case 'context_length':
      return { status: 400, name: 'ValidationException', message: 'Input is too long for requested model.' };
    case 'request_too_large':
      return { status: 400, name: 'ValidationException', message: 'Request payload size exceeds the limit.' };
    case 'rate_limit':
      return { status: 429, name: 'ThrottlingException', message: 'Too many requests, please wait before trying again.' };
    case 'server':
      return { status: 500, name: 'InternalServerException', message: 'The system encountered an unexpected error during processing. Try your request again.' };
    case 'overloaded':
      return { status: 503, name: 'ServiceUnavailableException', message: 'Bedrock is unable to process your request.' };
  }
}

const STREAM_EXCEPTION: Record<ErrorKind, string> = {
  bad_request: 'validationException',
  context_length: 'validationException',
  request_too_large: 'validationException',
  auth: 'modelStreamErrorException',
  permission: 'modelStreamErrorException',
  not_found: 'modelStreamErrorException',
  rate_limit: 'throttlingException',
  server: 'internalServerException',
  overloaded: 'serviceUnavailableException',
};

function requestId(ctx: RenderContext): Record<string, string> {
  const h = () => ctx.rng.id(8).toLowerCase();
  return { 'x-amzn-requestid': `${h()}-${h().slice(0, 4)}-${h().slice(0, 4)}-${h().slice(0, 4)}-${h()}${h().slice(0, 4)}` };
}

function usageHeaders(ctx: RenderContext): Record<string, string> {
  return {
    'x-amzn-bedrock-input-token-count': String(ctx.usage.inputTokens),
    'x-amzn-bedrock-output-token-count': String(ctx.usage.outputTokens),
    'x-amzn-bedrock-invocation-latency': '1',
  };
}

/**
 * CountTokens' `input.invokeModel.body` is a blob, so the SDK sends it base64-encoded. A raw JSON string
 * (hand-built requests) is accepted too: `{` can't start base64.
 */
function invokeBodyJson(body: string): unknown {
  const text = body.trimStart().startsWith('{') ? body : Buffer.from(body, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError({ kind: 'bad_request', message: 'The provided request is not valid: input.invokeModel.body is not a valid model request body.' });
  }
}
