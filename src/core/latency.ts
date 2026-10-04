import { Rng } from './rng.js';

/**
 * A delay in milliseconds: a fixed number, uniform `{ min, max }`, or
 * `{ distribution: 'normal', mean, stdDev }` (clamped at 0). Random delays are
 * drawn from a seeded stream, so the same seed gives the same delays.
 */
export type Delay = number | { min: number; max: number } | { distribution: 'normal'; mean: number; stdDev: number };

export interface LatencySpec {
  /** Time before the first byte/token. */
  firstTokenMs?: Delay;
  /** Streaming speed (chunks per second); 0 = as fast as possible. */
  tokensPerSec?: number;
}

/** The latency actually applied to one request (recorded on its journal entry). */
export interface AppliedLatency {
  firstTokenMs: number;
  tokensPerSec: number;
  /** Set when a step's `chunkIntervalMs` overrides `tokensPerSec`. */
  chunkIntervalMs?: number;
}

/** Throw a descriptive error for an invalid delay (called when rules are defined, not per request). */
export function validateDelay(d: unknown, label = 'delay'): asserts d is Delay | undefined {
  if (d === undefined) return;
  const bad = (why: string) => {
    throw new Error(`mock-llm: invalid ${label} ${JSON.stringify(d)}: ${why}`);
  };
  if (typeof d === 'number') {
    if (!Number.isFinite(d) || d < 0) bad('must be a non-negative number of ms');
    return;
  }
  if (!d || typeof d !== 'object') return bad('expected ms, { min, max } or { distribution: "normal", mean, stdDev }');
  const o = d as Record<string, unknown>;
  if ('distribution' in o) {
    if (o.distribution !== 'normal') bad('only distribution "normal" is supported');
    if (typeof o.mean !== 'number' || typeof o.stdDev !== 'number') bad('normal needs numeric mean and stdDev');
    if ((o.stdDev as number) < 0) bad('stdDev must be ≥ 0');
    return;
  }
  if (typeof o.min !== 'number' || typeof o.max !== 'number') return bad('expected ms, { min, max } or { distribution: "normal", mean, stdDev }');
  if ((o.min as number) < 0 || (o.max as number) < (o.min as number)) bad('needs 0 ≤ min ≤ max');
}

export function validateLatency(spec: LatencySpec | undefined, label = 'latency'): void {
  if (!spec) return;
  validateDelay(spec.firstTokenMs, `${label}.firstTokenMs`);
  if (spec.tokensPerSec !== undefined && !(typeof spec.tokensPerSec === 'number' && spec.tokensPerSec >= 0)) {
    throw new Error(`mock-llm: invalid ${label}.tokensPerSec ${JSON.stringify(spec.tokensPerSec)}: must be a number ≥ 0`);
  }
}

/** Sample a delay in whole ms (≥ 0). Fixed delays never consume randomness. */
export function sampleDelay(d: Delay | undefined, rng: Rng): number {
  if (d === undefined) return 0;
  if (typeof d === 'number') return Math.round(d);
  if ('distribution' in d) {
    // Box–Muller transform on the seeded stream.
    const u1 = Math.max(rng.next(), Number.MIN_VALUE);
    const u2 = rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(d.mean + z * d.stdDev));
  }
  return Math.round(d.min + rng.next() * (d.max - d.min));
}

/** Seed for the latency stream, derived from the mock seed so content randomness is unaffected. */
export function latencyRng(seed: number): Rng {
  return new Rng((seed ^ 0x5bd1e995) >>> 0);
}
