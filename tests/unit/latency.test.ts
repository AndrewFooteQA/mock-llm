import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { latencyRng, sampleDelay } from '../../src/core/latency.js';
import { Rng } from '../../src/core/rng.js';
import { createMockLLM, faults, type MockLLM, type MockLLMOptions } from '../../src/index.js';

let mocks: MockLLM[] = [];
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.stop()));
  mocks = [];
});
const start = async (opts: MockLLMOptions = {}) => {
  const m = await createMockLLM(opts);
  mocks.push(m);
  return m;
};
const ask = (m: MockLLM, content = 'hi', extra: Record<string, unknown> = {}) =>
  new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    ...extra,
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);
const streamAll = async (m: MockLLM, content = 'hi') => {
  const s = await new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [{ role: 'user', content }],
  });
  let text = '';
  for await (const c of s) text += c.choices[0]?.delta?.content ?? '';
  return text;
};
const delays = (m: MockLLM) => m.journal.all().map((e) => e.latency?.firstTokenMs);

describe('sampleDelay', () => {
  it('fixed, uniform and normal delays', () => {
    const rng = new Rng(1);
    expect(sampleDelay(25, rng)).toBe(25);
    expect(sampleDelay(undefined, rng)).toBe(0);
    const uniform = Array.from({ length: 500 }, () => sampleDelay({ min: 100, max: 200 }, rng));
    expect(Math.min(...uniform)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...uniform)).toBeLessThanOrEqual(200);
    const normal = Array.from({ length: 4000 }, () => sampleDelay({ distribution: 'normal', mean: 300, stdDev: 50 }, rng));
    const mean = normal.reduce((a, b) => a + b, 0) / normal.length;
    expect(mean).toBeGreaterThan(290);
    expect(mean).toBeLessThan(310);
    const clamped = Array.from({ length: 500 }, () => sampleDelay({ distribution: 'normal', mean: 0, stdDev: 100 }, rng));
    expect(Math.min(...clamped)).toBe(0); // never negative
  });

  it('is reproducible from the seed, and fixed delays consume no randomness', () => {
    const a = latencyRng(42);
    const b = latencyRng(42);
    const seq = (r: Rng) => [sampleDelay({ min: 0, max: 1000 }, r), sampleDelay(5, r), sampleDelay({ min: 0, max: 1000 }, r)];
    expect(seq(a)).toEqual(seq(b));
    expect(seq(latencyRng(42))).not.toEqual(seq(latencyRng(43)));
  });
});

describe('precedence: step delay > rule latency > global latency', () => {
  it('records the applied latency and the response never arrives early', async () => {
    const m = await start({ latency: { firstTokenMs: 30 } });
    m.when('global').reply('g');
    m.when('rule').latency({ firstTokenMs: 60 }).reply('r');
    m.when('step').latency({ firstTokenMs: 60 }).reply('s', { delay: 90 });

    for (const [prompt, expected] of [['global', 30], ['rule', 60], ['step', 90]] as const) {
      const t0 = performance.now();
      await ask(m, prompt);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(expected - 2); // lower bound only (no flaky upper bound)
      expect(m.journal.last()!.latency).toEqual({ firstTokenMs: expected, tokensPerSec: 0 });
    }
  });

  it('sequence steps can each have their own delay (a "slow agent")', async () => {
    const m = await start();
    m.when({}).reply('Searching…', { delay: 10 }).then.reply('Found it', { delay: 40 }).then.reply('Done', { delay: 20 });
    for (let i = 0; i < 3; i++) await ask(m);
    expect(delays(m)).toEqual([10, 40, 20]);
  });

  it('rule tokensPerSec overrides the global streaming speed', async () => {
    const m = await start({ latency: { tokensPerSec: 0 } });
    m.when({}).latency({ tokensPerSec: 100 }).reply('one two three four five six');
    const t0 = performance.now();
    expect(await streamAll(m)).toBe('one two three four five six');
    // 6 word chunks + role/finish/[DONE] frames at 100/s → at least ~80 ms of spacing.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(75);
    expect(m.journal.last()!.latency).toEqual({ firstTokenMs: 0, tokensPerSec: 100 });
  });

  it('stream faults honour rule latency', async () => {
    const m = await start();
    m.when({}).latency({ firstTokenMs: 25 }).fail(faults.streamCut({ afterChunks: 2 }));
    await streamAll(m).catch(() => {});
    expect(m.journal.last()!.latency?.firstTokenMs).toBe(25);
  });
});

describe('seeded random latency', () => {
  const scripted = async (seed: number) => {
    const m = await start({ seed, latency: { firstTokenMs: { min: 0, max: 40 } } });
    m.when('normal').latency({ firstTokenMs: { distribution: 'normal', mean: 20, stdDev: 10 } }).replyLorem({ tokens: 5 });
    m.default().replyLorem({ tokens: 5 });
    const texts: string[] = [];
    for (const p of ['a', 'normal', 'b', 'normal', 'c']) texts.push((await ask(m, p)).choices[0]!.message.content!);
    return { delays: delays(m), texts };
  };

  it('same seed → same delays; different seed → different delays', async () => {
    const a = await scripted(7);
    const b = await scripted(7);
    const c = await scripted(8);
    expect(a.delays).toEqual(b.delays);
    expect(a.delays).not.toEqual(c.delays);
    for (const d of a.delays) expect(d).toBeGreaterThanOrEqual(0);
  });

  it('random latency does not change generated content (separate seeded stream)', async () => {
    const withLatency = await scripted(7);
    const m = await start({ seed: 7 });
    m.default().replyLorem({ tokens: 5 });
    const texts: string[] = [];
    for (const p of ['a', 'normal', 'b', 'normal', 'c']) texts.push((await ask(m, p)).choices[0]!.message.content!);
    expect(texts).toEqual(withLatency.texts);
  });

  it('reset() restarts the latency stream', async () => {
    const m = await start({ seed: 3, latency: { firstTokenMs: { min: 0, max: 30 } } });
    m.default().reply('x');
    await ask(m);
    await ask(m);
    const first = delays(m);
    m.reset();
    m.default().reply('x');
    await ask(m);
    await ask(m);
    expect(delays(m)).toEqual(first);
  });
});

describe('scenario files and validation', () => {
  it('supports rule latency and step delays in scenario files', async () => {
    const m = await start({ seed: 1 });
    await m.load({
      rules: [
        {
          when: { lastUserMessage: 'slow' },
          latency: { firstTokenMs: { min: 5, max: 15 }, tokensPerSec: 0 },
          steps: [{ reply: 'first', delay: 30 }, { reply: 'second' }],
        },
      ],
    });
    await ask(m, 'slow');
    await ask(m, 'slow');
    const [a, b] = delays(m);
    expect(a).toBe(30); // step delay wins
    expect(b).toBeGreaterThanOrEqual(5); // rule latency, sampled
    expect(b).toBeLessThanOrEqual(15);
  });

  it('rejects invalid delays where they are defined, with scenario locations', async () => {
    const m = await start();
    expect(() => m.when({}).reply('x', { delay: { min: 50, max: 10 } })).toThrow(/invalid delay .*0 ≤ min ≤ max/);
    expect(() => m.when({}).latency({ firstTokenMs: -5 })).toThrow(/invalid latency.firstTokenMs -5/);
    expect(() => m.when({}).latency({ firstTokenMs: { distribution: 'lognormal', mean: 1, stdDev: 1 } as any })).toThrow(/only distribution "normal"/);
    await expect(createMockLLM({ latency: { tokensPerSec: -1 } })).rejects.toThrow(/invalid latency.tokensPerSec/);
    await expect(m.load({ rules: [{ steps: [{ reply: 'a', delay: { min: 9, max: 1 } }] }] })).rejects.toThrow(/^scenario: rules\[0\]\.steps\[0\]: invalid delay/);
    await expect(m.load({ rules: [{ latency: { firstTokenMs: 'slow' }, reply: 'a' }] } as any)).rejects.toThrow(/^scenario: rules\[0\]: invalid latency\.firstTokenMs/);
    await expect(m.load({ rules: [{ fail: 'overloaded', delay: 10 }] })).rejects.toThrow(/delay is not supported on fail steps/);
  });
});
