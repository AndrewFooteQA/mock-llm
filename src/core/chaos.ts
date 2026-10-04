import { edge } from './edge.js';
import type { Rng } from './rng.js';
import type { Fault, IRContent, IRRequest, IRResponse } from './types.js';

/**
 * What chaos does to a request:
 * - `error`: a fault from the `faults` pool (rate limit / overloaded / 500 by default) instead of any reply;
 * - `refusal`, `empty`: the model refuses / says nothing;
 * - `truncated`: the *scripted* reply is cut off at max_tokens (text, or a tool call's JSON);
 * - `malformedToolCall`: the scripted tool call's arguments become invalid JSON, or (if the reply has no tool
 *   call) the model calls the first offered tool with broken arguments. Only when the request offers tools.
 */
export type ChaosBehaviour = 'error' | 'refusal' | 'empty' | 'truncated' | 'malformedToolCall';
export const CHAOS_BEHAVIOURS: readonly ChaosBehaviour[] = ['error', 'refusal', 'empty', 'truncated', 'malformedToolCall'];

export interface ChaosOptions {
  /** 0..1 probability per chat request. */
  rate: number;
  /** Relative weights per behaviour (default `{ error: 1 }`, i.e. errors only). */
  weights?: Partial<Record<ChaosBehaviour, number>>;
  /** Faults used by the `error` behaviour (default: rate limit, overloaded, server error). */
  faults?: Fault[];
}

export const DEFAULT_CHAOS_FAULTS: Fault[] = [
  { type: 'error', error: { kind: 'rate_limit', retryAfter: 0 } },
  { type: 'error', error: { kind: 'overloaded' } },
  { type: 'error', error: { kind: 'server' } },
];

export function validateChaos(opts: ChaosOptions | undefined): void {
  if (!opts) return;
  const bad = (why: string) => {
    throw new Error(`mock-llm: invalid chaos options: ${why}`);
  };
  if (!(typeof opts.rate === 'number' && opts.rate >= 0 && opts.rate <= 1)) bad(`rate must be a number between 0 and 1, got ${JSON.stringify(opts.rate)}`);
  if (opts.weights !== undefined) {
    if (!opts.weights || typeof opts.weights !== 'object') bad('weights must be an object');
    let total = 0;
    for (const [k, v] of Object.entries(opts.weights)) {
      if (!CHAOS_BEHAVIOURS.includes(k as ChaosBehaviour)) bad(`unknown behaviour "${k}" in weights (known: ${CHAOS_BEHAVIOURS.join(', ')})`);
      if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) bad(`weights.${k} must be a number ≥ 0`);
      total += v as number;
    }
    if (total <= 0) bad('weights must include at least one behaviour with weight > 0');
  }
  if (opts.faults !== undefined && !(Array.isArray(opts.faults) && opts.faults.length)) bad('faults must be a non-empty array');
}

/** Pick a behaviour by weight among those that apply to this request (seeded). Undefined if none apply. */
export function pickBehaviour(opts: ChaosOptions, req: IRRequest, rng: Rng): ChaosBehaviour | undefined {
  const weights = opts.weights ?? { error: 1 };
  const candidates = CHAOS_BEHAVIOURS.filter((b) => (weights[b] ?? 0) > 0 && (b !== 'malformedToolCall' || req.tools.length > 0));
  if (!candidates.length) return undefined;
  // A single candidate consumes no randomness, so errors-only chaos keeps the exact random sequence it had before
  // weights existed (seeds recorded with MOCK_LLM_SEED stay valid across upgrades).
  if (candidates.length === 1) return candidates[0];
  const total = candidates.reduce((n, b) => n + weights[b]!, 0);
  let r = rng.next() * total;
  for (const b of candidates) {
    r -= weights[b]!;
    if (r < 0) return b;
  }
  return candidates.at(-1);
}

/** Apply a content behaviour to the reply the rules produced. */
export function applyContentChaos(behaviour: Exclude<ChaosBehaviour, 'error'>, res: IRResponse, req: IRRequest): IRResponse {
  const text = res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
  const call = res.content.find((c): c is Extract<IRContent, { type: 'tool_call' }> => c.type === 'tool_call');
  const json = (input: unknown) => (typeof input === 'string' ? input : JSON.stringify(input ?? {}));
  switch (behaviour) {
    case 'refusal':
      return edge.refusal();
    case 'empty':
      return edge.empty();
    case 'truncated':
      if (text) return edge.truncated(text);
      if (call) {
        const raw = json(call.input);
        return { content: [{ ...call, input: raw.slice(0, Math.max(1, Math.floor(raw.length / 2))) }], stopReason: 'max_tokens' };
      }
      return { content: [{ type: 'text', text: '' }], stopReason: 'max_tokens' };
    case 'malformedToolCall':
      if (call) {
        const raw = json(call.input);
        return { content: [{ ...call, input: raw.slice(0, Math.max(1, raw.length - 2)) }], stopReason: 'tool_use' };
      }
      return edge.malformedToolArgs(req.tools[0]!.name);
  }
}
