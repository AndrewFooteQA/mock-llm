// The runs the tutorial can make, shared by the browser (app.js), playground:check and the recorder.
// Plain ESM with no browser or Node specifics, so both sides compute the same payloads and keys.
import { LESSONS, PROVIDERS } from './lessons.js';

/** The free-form Playground page's default form. */
export const PG_DEFAULT = {
  provider: 'openai',
  model: '',
  prompt: "What's the weather in Paris?",
  system: '',
  stream: true,
  tools: true,
  structured: false,
  agentLoop: true,
  maxRetries: 0,
  timeoutMs: '',
  scenarioHeader: '',
  firstTokenMs: 0,
  tokensPerSec: 0,
  seed: 1,
  rules: LESSONS.find((l) => l.id === 'agent-loop').yaml,
};

/** The /api/run payload for the Playground form values `v`. */
export function playgroundPayload(v) {
  return {
    ...v,
    maxRetries: v.maxRetries || 0,
    timeoutMs: v.timeoutMs || undefined,
    latency: v.firstTokenMs || v.tokensPerSec ? { firstTokenMs: v.firstTokenMs || 0, tokensPerSec: v.tokensPerSec || 0 } : undefined,
  };
}

/** The /api/run payload for a lesson variant on a provider (exactly what the lesson page sends). */
export const lessonPayload = (lesson, variant, provider) => ({ ...lesson.run, ...variant?.run, provider, rules: variant?.yaml ?? lesson.yaml ?? '' });

/**
 * Every run the tutorial offers without the visitor editing anything: each lesson × variant × provider, plus the
 * Playground page's default form on each provider. playground:check checks them all; the static site replays them.
 */
export function enumerateRuns() {
  const runs = [];
  for (const lesson of LESSONS.filter((l) => !l.static)) {
    const variants = lesson.variants?.length ? lesson.variants : [{ label: '(default)' }];
    for (const variant of variants) {
      for (const provider of PROVIDERS.map((p) => p.id).filter((id) => !lesson.providers || lesson.providers.includes(id))) {
        runs.push({ where: `${lesson.id} / ${variant.label} / ${provider}`, lesson, variant, provider, payload: lessonPayload(lesson, variant, provider) });
      }
    }
  }
  for (const { id: provider } of PROVIDERS) {
    runs.push({ where: `playground / default / ${provider}`, playground: true, provider, payload: playgroundPayload({ ...PG_DEFAULT, provider }) });
  }
  return runs;
}

/** JSON with sorted keys and no undefined values, so equal payloads always serialise the same way. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The recording file name for a payload: the first 16 hex chars of SHA-256 over its canonical JSON. */
export async function runKey(payload) {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
