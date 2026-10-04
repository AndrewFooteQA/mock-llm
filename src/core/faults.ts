import type { ErrorSpec, Fault, IRResponse } from './types.js';

const err = (kind: ErrorSpec['kind'], defaults: Partial<ErrorSpec> = {}) =>
  (opts: Partial<Omit<ErrorSpec, 'kind'>> = {}): Fault => ({
    type: 'error',
    error: { kind, ...defaults, ...opts },
  });

/**
 * Fault catalog. Error faults render in each provider's native error envelope
 * and status code, so the official SDKs raise their real exception types.
 */
export const faults = {
  badRequest: err('bad_request'),
  authError: err('auth'),
  permissionDenied: err('permission'),
  notFound: err('not_found'),
  /** Pass `details: { limit, inputTokens }` for real numbers in the provider's message. */
  contextLengthExceeded: err('context_length'),
  requestTooLarge: err('request_too_large'),
  rateLimit: err('rate_limit', { retryAfter: 1 }),
  serverError: err('server'),
  overloaded: err('overloaded'),

  /** Any status/body you like, sent verbatim. */
  raw(status: number, body: string | object, headers?: Record<string, string>): Fault {
    return {
      type: 'raw',
      status,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: typeof body === 'string' ? headers : { 'content-type': 'application/json', ...headers },
    };
  },

  /** Destroy the socket without responding. */
  connectionReset(): Fault {
    return { type: 'connection_reset' };
  },

  /** Never respond; after `ms` (if given) the socket is reset. Use with client timeouts. */
  timeout(opts: { ms?: number } = {}): Fault {
    return { type: 'timeout', ...opts };
  },

  /** Send `afterChunks` stream chunks, then drop the connection mid-stream. */
  streamCut(opts: { afterChunks?: number; response?: Partial<IRResponse> } = {}): Fault {
    return { type: 'stream_cut', afterChunks: opts.afterChunks ?? 3, response: opts.response };
  },

  /** Send `afterChunks` stream chunks, then a provider-native error event. */
  streamError(opts: { afterChunks?: number; error?: ErrorSpec; response?: Partial<IRResponse> } = {}): Fault {
    return {
      type: 'stream_error',
      afterChunks: opts.afterChunks ?? 3,
      error: opts.error ?? { kind: 'overloaded' },
      response: opts.response,
    };
  },
};
