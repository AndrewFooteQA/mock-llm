import { edge } from './edge.js';
import { faults } from './faults.js';
import type { Step } from './rules.js';
import type { IRRequest, IRResponse } from './types.js';

const respond = (fn: (req: IRRequest) => IRResponse): Step => ({ kind: 'respond', fn });
const fault = (f: Step & { kind: 'fault' }): Step => f;
const firstTool = (req: IRRequest) => req.tools[0]?.name ?? 'unknown_tool';

/**
 * Built-in scenarios, selectable per request without code changes via the
 * `x-mock-scenario: <name>` header or a `[[mock:<name>]]` token in the prompt.
 */
export const builtinScenarios: Record<string, Step> = {
  // HTTP errors (provider-native envelopes)
  'bad-request': fault({ kind: 'fault', fault: faults.badRequest() }),
  'auth-error': fault({ kind: 'fault', fault: faults.authError() }),
  'permission-denied': fault({ kind: 'fault', fault: faults.permissionDenied() }),
  'not-found': fault({ kind: 'fault', fault: faults.notFound() }),
  'context-length': fault({ kind: 'fault', fault: faults.contextLengthExceeded() }),
  'request-too-large': fault({ kind: 'fault', fault: faults.requestTooLarge() }),
  'rate-limit': fault({ kind: 'fault', fault: faults.rateLimit() }),
  'server-error': fault({ kind: 'fault', fault: faults.serverError() }),
  overloaded: fault({ kind: 'fault', fault: faults.overloaded() }),
  // Network / streaming
  timeout: fault({ kind: 'fault', fault: faults.timeout() }),
  'connection-reset': fault({ kind: 'fault', fault: faults.connectionReset() }),
  'stream-cut': fault({ kind: 'fault', fault: faults.streamCut() }),
  'stream-error': fault({ kind: 'fault', fault: faults.streamError() }),
  // Awkward content
  empty: respond(() => edge.empty()),
  truncated: respond(() => edge.truncated('{"status": "ok", "items": [{"id": 1, "name": "first"}, {"id": 2, "name": "sec')),
  refusal: respond(() => edge.refusal()),
  'content-filter': respond(() => edge.contentFilter()),
  unicode: respond(() => edge.unicode()),
  'prompt-injection': respond(() => edge.promptInjection()),
  pii: respond(() => edge.piiLike()),
  long: respond(() => edge.long()),
  'code-fenced-json': respond(() => edge.codeFencedJson({ status: 'ok', items: [1, 2, 3] })),
  'almost-json': respond(() => edge.almostJson({ status: 'ok', count: 3 })),
  'malformed-tool-args': respond((req) => edge.malformedToolArgs(firstTool(req))),
  'hallucinated-tool': respond(() => edge.hallucinatedTool()),
  'wrong-tool-args': respond((req) => edge.wrongToolArgTypes(firstTool(req))),
};
