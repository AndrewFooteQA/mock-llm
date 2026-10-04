import type { Rng } from '../core/rng.js';
import type { Endpoint, ErrorSpec, IRRequest, IRResponse, IRUsage, Provider } from '../core/types.js';

/** Thrown by adapters (e.g. request validation); rendered in the provider's error envelope. */
export class ApiError extends Error {
  constructor(readonly spec: ErrorSpec) {
    super(spec.message ?? spec.kind);
  }
}

export interface RenderContext {
  rng: Rng;
  usage: IRUsage;
  /** Unix seconds. */
  created: number;
  /** Model ids advertised by the models endpoints. */
  models: string[];
  /** Per-mock mutable state (e.g. stored Responses API conversations). Cleared by reset(). */
  state: Map<string, unknown>;
}

export interface HttpReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * A provider adapter translates between one provider's wire protocol and the IR.
 * Add a provider (Gemini, Bedrock, ...) by implementing this interface and
 * registering it in the server's route table.
 */
export interface Adapter {
  provider: Provider;
  /** Map a method + path (relative to the provider's root, e.g. `/v1/messages`) to an endpoint. */
  route(method: string, path: string): Endpoint | null;
  /** Parse and validate a request body. Throws ApiError on invalid input. */
  parse(endpoint: Endpoint, body: any, headers: Record<string, string>, path: string, state: Map<string, unknown>): IRRequest;
  /** The API key the client sent, if any (used when `apiKeys` is configured). */
  apiKey(headers: Record<string, string>): string | undefined;
  /** Non-streaming chat response body. */
  render(req: IRRequest, res: IRResponse, ctx: RenderContext): HttpReply;
  /** Streaming chat response as a list of wire chunks (SSE frames, or binary frames). */
  stream(req: IRRequest, res: IRResponse, ctx: RenderContext): { contentType: string; headers?: Record<string, string>; chunks: Array<string | Uint8Array> };
  /** An in-stream error frame (sent mid-stream by `faults.streamError`). */
  streamError(error: ErrorSpec, ctx: RenderContext, req?: IRRequest): string | Uint8Array;
  /** HTTP error in the provider's native envelope. */
  error(error: ErrorSpec, ctx: RenderContext): HttpReply;
  /** Non-chat endpoints (models, embeddings, token counting). */
  other(req: IRRequest, ctx: RenderContext): HttpReply;
}

export function sse(data: unknown, event?: string): string {
  return (event ? `event: ${event}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export function retryHeaders(error: ErrorSpec): Record<string, string> {
  if (error.retryAfter === undefined) return {};
  return {
    'retry-after': String(Math.max(0, Math.ceil(error.retryAfter))),
    'retry-after-ms': String(Math.round(error.retryAfter * 1000)),
  };
}

/** Split a string into fixed-size pieces (used for streaming tool-call arguments). */
export function pieces(s: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}

export function toolInputString(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? {});
}

export function defaultStopReason(res: IRResponse): NonNullable<IRResponse['stopReason']> {
  return res.stopReason ?? (res.content.some((c) => c.type === 'tool_call') ? 'tool_use' : 'end_turn');
}

export function requireField(cond: boolean, message: string): void {
  if (!cond) throw new ApiError({ kind: 'bad_request', message });
}
