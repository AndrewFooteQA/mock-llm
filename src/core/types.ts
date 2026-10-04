/**
 * Canonical, provider-neutral intermediate representation (IR).
 * Provider adapters parse wire requests into IRRequest and render IRResponse
 * back into each provider's exact wire format, so rules are written once.
 */

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'bedrock';

/** Logical endpoint names, shared across providers where possible. */
/** `unknown` = a path the provider doesn't serve (recorded in the journal, answered with a native 404). */
export type Endpoint = 'chat' | 'count_tokens' | 'embeddings' | 'models' | 'unknown';

export type IRRequestPart =
  | { type: 'text'; text: string }
  | { type: 'image' }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'thinking'; text: string };

export interface IRMessage {
  role: 'user' | 'assistant' | 'tool';
  content: IRRequestPart[];
}

export interface IRTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface IRRequest {
  provider: Provider;
  endpoint: Endpoint;
  /** Raw URL path that was called, e.g. `/v1/chat/completions`. */
  path: string;
  model: string;
  system?: string;
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice?: unknown;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; schema?: unknown };
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
  /** Original parsed JSON body, for anything the IR doesn't model. */
  raw: any;
}

export type IRContent =
  /** `chunks`, when set, are the exact stream pieces (their concatenation must equal `text`). */
  | { type: 'text'; text: string; chunks?: string[] }
  | {
      type: 'tool_call';
      id?: string;
      name: string;
      /** Object input, or a raw string to simulate malformed tool arguments. */
      input: unknown;
    }
  | { type: 'thinking'; text: string };

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'refusal'
  | 'content_filter';

export interface IRUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface IRResponse {
  content: IRContent[];
  /** Defaults to `tool_use` when content has a tool call, else `end_turn`. */
  stopReason?: StopReason;
  /** Overrides the approximate token counts the mock computes. */
  usage?: Partial<IRUsage>;
  /** Overrides the model echoed back (defaults to the requested model). */
  model?: string;
}

/** Semantic error kinds; each adapter maps these to its native status + envelope. */
export type ErrorKind =
  | 'bad_request'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'context_length'
  | 'request_too_large'
  | 'rate_limit'
  | 'server'
  | 'overloaded';

export interface ErrorSpec {
  kind: ErrorKind;
  message?: string;
  /** Seconds; sent as `retry-after` (and `retry-after-ms`). */
  retryAfter?: number;
  /** Override the HTTP status the adapter would pick. */
  status?: number;
  headers?: Record<string, string>;
  /** For `context_length`: real numbers for the provider's native message. */
  details?: { limit: number; inputTokens: number };
  /** Appended to the provider's native message (mock-llm tags chaos faults with the seed). */
  note?: string;
}

export type Fault =
  | { type: 'error'; error: ErrorSpec }
  | { type: 'raw'; status: number; body: string; headers?: Record<string, string> }
  | { type: 'connection_reset' }
  /** Accept the request but never answer (until `ms` elapses, then reset). */
  | { type: 'timeout'; ms?: number }
  /** Stream (or partially write) a response, then drop the connection. */
  | { type: 'stream_cut'; afterChunks: number; response?: Partial<IRResponse> }
  /** Stream part of a response, then emit a provider-native in-stream error event. */
  | { type: 'stream_error'; afterChunks: number; error: ErrorSpec; response?: Partial<IRResponse> };
