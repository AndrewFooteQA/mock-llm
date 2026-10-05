import { describe, expect, it } from 'vitest';
import { canonicalJson, enumerateRuns, lessonPayload, PG_DEFAULT, playgroundPayload, runKey } from '../../playground/public/runs.js';

describe('playground runs (shared by the page, playground:check and the static site)', () => {
  it('canonical JSON sorts keys and drops undefined, so equal payloads get equal keys', async () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, undefined] } })).toBe('{"a":{"c":[1,null]},"b":1}');
    expect(await runKey({ provider: 'openai', rules: 'x', stream: true })).toBe(await runKey({ stream: true, rules: 'x', provider: 'openai', extra: undefined }));
    expect(await runKey({ provider: 'openai' })).not.toBe(await runKey({ provider: 'gemini' }));
    expect(await runKey({ provider: 'openai' })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('every tutorial run has its own recording key (no two runs would replay the same file)', async () => {
    const runs = enumerateRuns();
    const keys = await Promise.all(runs.map((r) => runKey(r.payload)));
    expect(new Set(keys).size).toBe(runs.length);
    expect(runs.filter((r) => r.playground).map((r) => r.provider)).toEqual(['openai', 'openai-responses', 'anthropic', 'gemini', 'bedrock']);
  });

  it("builds the same payload the lesson page sends (variant run and YAML override the lesson's)", () => {
    const lesson = { run: { prompt: 'hi', stream: false }, yaml: 'rules: []', variants: [{ label: 'v', run: { stream: true }, yaml: 'default: { reply: x }' }] };
    expect(lessonPayload(lesson, lesson.variants[0], 'gemini')).toEqual({ prompt: 'hi', stream: true, provider: 'gemini', rules: 'default: { reply: x }' });
    expect(lessonPayload(lesson, { label: '(default)' }, 'gemini')).toEqual({ prompt: 'hi', stream: false, provider: 'gemini', rules: 'rules: []' });
  });

  it('turns the Playground form into a payload (latency only when set, empty timeout dropped)', () => {
    const p = playgroundPayload({ ...PG_DEFAULT, firstTokenMs: 200 });
    expect(p).toMatchObject({ latency: { firstTokenMs: 200, tokensPerSec: 0 }, timeoutMs: undefined, maxRetries: 0 });
    expect(playgroundPayload(PG_DEFAULT).latency).toBeUndefined();
  });
});
