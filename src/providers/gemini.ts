import { embedding } from '../core/rng.js';
import { chunkText, textPieces } from '../core/tokens.js';
import type { ErrorSpec, IRContent, IRMessage, IRRequest, IRRequestPart, IRResponse, IRTool, StopReason } from '../core/types.js';
import { ApiError, defaultStopReason, requireField, retryHeaders, sse, type Adapter, type RenderContext } from './adapter.js';

/**
 * Google Gemini API: AI Studio (`/v1beta/models/{m}:generateContent`) and
 * Vertex AI (`/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:...`).
 */

// [version, model, method]
const MODEL_CALL = /^\/(v1|v1beta|v1beta1|v1alpha)\/(?:projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/)?models\/([^/:]+):(\w+)$/;
const MODEL_GET = /^\/(v1|v1beta|v1beta1|v1alpha)\/(?:projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/)?models(?:\/([^/:]+))?$/;

export const geminiAdapter: Adapter = {
  provider: 'gemini',

  route(method, path) {
    const call = path.match(MODEL_CALL);
    if (method === 'POST' && call) {
      switch (call[3]) {
        case 'generateContent':
        case 'streamGenerateContent':
          return 'chat';
        case 'countTokens':
          return 'count_tokens';
        case 'embedContent':
        case 'batchEmbedContents':
          return 'embeddings';
      }
      return null;
    }
    if (method === 'GET' && MODEL_GET.test(path)) return 'models';
    return null;
  },

  apiKey(headers) {
    return headers['x-goog-api-key'] || headers['authorization']?.replace(/^Bearer\s+/i, '') || undefined;
  },

  parse(endpoint, body, headers, path) {
    const call = path.match(MODEL_CALL);
    const model = decodeURIComponent(call?.[2] ?? path.match(MODEL_GET)?.[2] ?? '');
    const base: IRRequest = { provider: 'gemini', endpoint, path, model, messages: [], tools: [], stream: false, headers, raw: body };
    if (endpoint === 'models' || endpoint === 'embeddings') return base;

    // countTokens accepts either {contents} or {generateContentRequest: {...}}
    const req = endpoint === 'count_tokens' && body?.generateContentRequest ? body.generateContentRequest : body;
    requireField(Array.isArray(req?.contents) && req.contents.length > 0, '* GenerateContentRequest.contents: contents is not specified');

    const messages: IRMessage[] = [];
    for (const c of req.contents) {
      const parts: any[] = c?.parts ?? [];
      const content: IRRequestPart[] = [];
      const results: IRRequestPart[] = [];
      for (const p of parts) {
        if (typeof p.text === 'string') content.push(p.thought ? { type: 'thinking', text: p.text } : { type: 'text', text: p.text });
        else if (p.functionCall) content.push({ type: 'tool_call', id: p.functionCall.id ?? p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args ?? {} });
        else if (p.functionResponse) {
          results.push({ type: 'tool_result', toolCallId: p.functionResponse.id ?? p.functionResponse.name, content: JSON.stringify(p.functionResponse.response ?? {}) });
        } else content.push({ type: 'image' });
      }
      if (c.role === 'model') messages.push({ role: 'assistant', content });
      else {
        if (results.length) messages.push({ role: 'tool', content: results });
        if (content.length) messages.push({ role: 'user', content });
      }
    }

    const tools: IRTool[] = (req.tools ?? []).flatMap((t: any) =>
      (t.functionDeclarations ?? []).map((f: any) => ({ name: f.name, description: f.description, inputSchema: f.parametersJsonSchema ?? f.parameters })),
    );

    const gc = req.generationConfig ?? {};
    const schema = gc.responseJsonSchema ?? gc.responseSchema;
    const sys = req.systemInstruction ?? req.system_instruction;
    return {
      ...base,
      system: sys ? (sys.parts ?? []).map((p: any) => p.text ?? '').join('\n') || undefined : undefined,
      messages,
      tools,
      toolChoice: req.toolConfig,
      responseFormat: gc.responseMimeType === 'application/json' ? { type: schema ? 'json_schema' : 'json_object', schema } : undefined,
      stream: call?.[3] === 'streamGenerateContent',
      maxTokens: gc.maxOutputTokens,
      temperature: gc.temperature,
    };
  },

  render(req, res, ctx) {
    return { status: 200, headers: {}, body: chunkBody(req, res, ctx, res.content, defaultStopReason(res), true) };
  },

  stream(req, res, ctx) {
    const stop = defaultStopReason(res);
    const pieces: IRContent[][] = [];
    for (const c of res.content) {
      if (c.type === 'tool_call') pieces.push([c]); // function calls arrive whole
      else for (const text of c.type === 'text' ? textPieces(c) : chunkText(c.text)) pieces.push([{ ...c, text }]);
    }
    if (!pieces.length) pieces.push([]);
    const chunks = pieces.map((content, i) => sse(chunkBody(req, res, ctx, content, i === pieces.length - 1 ? stop : null, i === pieces.length - 1)));
    return { contentType: 'text/event-stream', headers: {}, chunks };
  },

  streamError(error) {
    // Gemini sends a bare JSON error object mid-stream (not an SSE frame).
    return JSON.stringify({ error: envelope(error).error });
  },

  error(error, ctx) {
    const { status, error: body } = envelope(error);
    return { status: error.status ?? status, headers: { ...retryHeaders(error), ...error.headers }, body: { error: body } };
  },

  other(req, ctx) {
    if (req.endpoint === 'count_tokens') return { status: 200, headers: {}, body: { totalTokens: ctx.usage.inputTokens } };
    if (req.endpoint === 'embeddings') {
      const texts = (c: any) => (c?.parts ?? []).map((p: any) => p.text ?? '').join(' ');
      const dims = (r: any) => r?.outputDimensionality ?? r?.output_dimensionality ?? 768;
      if (req.path.endsWith(':batchEmbedContents')) {
        const requests: any[] = req.raw?.requests ?? [];
        return { status: 200, headers: {}, body: { embeddings: requests.map((r) => ({ values: Array.from(embedding(texts(r.content), dims(r))) })) } };
      }
      return { status: 200, headers: {}, body: { embedding: { values: Array.from(embedding(texts(req.raw?.content), dims(req.raw))) } } };
    }
    const model = (id: string) => ({
      name: `models/${id}`,
      displayName: id,
      version: '001',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    });
    if (req.model) {
      if (!ctx.models.includes(req.model)) throw new ApiError({ kind: 'not_found', message: `models/${req.model} is not found for API version v1beta.` });
      return { status: 200, headers: {}, body: model(req.model) };
    }
    return { status: 200, headers: {}, body: { models: ctx.models.map(model) } };
  },
};

const FINISH: Record<StopReason, string> = {
  end_turn: 'STOP',
  stop_sequence: 'STOP',
  tool_use: 'STOP',
  refusal: 'STOP',
  max_tokens: 'MAX_TOKENS',
  content_filter: 'SAFETY',
};

function chunkBody(req: IRRequest, res: IRResponse, ctx: RenderContext, content: IRContent[], stop: StopReason | null, withUsage: boolean) {
  // A string tool input can't be expressed as Gemini `args`; real Gemini reports MALFORMED_FUNCTION_CALL.
  const malformed = content.some((c) => c.type === 'tool_call' && typeof c.input === 'string');
  const parts = malformed
    ? []
    : content.map((c) =>
        c.type === 'text'
          ? { text: c.text }
          : c.type === 'thinking'
            ? { text: c.text, thought: true }
            : { functionCall: { name: c.name, args: c.input ?? {}, ...(c.id ? { id: c.id } : {}) } },
      );
  const candidate: Record<string, unknown> = { content: { role: 'model', parts }, index: 0 };
  if (stop) candidate.finishReason = malformed ? 'MALFORMED_FUNCTION_CALL' : FINISH[stop];
  if (stop === 'content_filter') {
    candidate.safetyRatings = [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }];
  }
  const { inputTokens, outputTokens } = ctx.usage;
  return {
    candidates: [candidate],
    usageMetadata: withUsage
      ? { promptTokenCount: inputTokens, candidatesTokenCount: outputTokens, totalTokenCount: inputTokens + outputTokens }
      : { promptTokenCount: inputTokens, totalTokenCount: inputTokens },
    modelVersion: res.model ?? req.model,
    responseId: ctx.rng.id(22),
  };
}

function envelope(e: ErrorSpec): { status: number; error: Record<string, unknown> } {
  const make = (code: number, status: string, message: string, details?: unknown[]) => ({
    status: code,
    error: { code, message: `${e.message ?? message}${e.note ? ` ${e.note}` : ''}`, status, ...(details ? { details } : {}) },
  });
  switch (e.kind) {
    case 'bad_request':
      return make(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.');
    case 'auth':
      // AI Studio answers a bad key with 400 + reason API_KEY_INVALID (Vertex uses 401).
      return make(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
      ]);
    case 'permission':
      return make(403, 'PERMISSION_DENIED', 'The caller does not have permission.');
    case 'not_found':
      return make(404, 'NOT_FOUND', 'Requested entity was not found.');
    case 'context_length':
      return make(
        400,
        'INVALID_ARGUMENT',
        `The input token count (${e.details?.inputTokens ?? 1100000}) exceeds the maximum number of tokens allowed (${e.details?.limit ?? 1048576}).`,
      );
    case 'request_too_large':
      return make(400, 'INVALID_ARGUMENT', 'Request payload size exceeds the limit.');
    case 'rate_limit':
      return make(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.', [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${e.retryAfter ?? 1}s` },
      ]);
    case 'server':
      return make(500, 'INTERNAL', 'An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting');
    case 'overloaded':
      return make(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.');
  }
}
