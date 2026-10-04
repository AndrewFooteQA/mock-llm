import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { pickBehaviour } from '../../src/core/chaos.js';
import { Rng } from '../../src/core/rng.js';
import { createMockLLM, faults, type ChaosOptions, type MockLLM } from '../../src/index.js';

let mocks: MockLLM[] = [];
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.stop()));
  mocks = [];
});
const start = async (seed: number, chaos: ChaosOptions) => {
  const m = await createMockLLM({ seed, chaos });
  mocks.push(m);
  return m;
};
const tool = { type: 'function' as const, function: { name: 'lookup', parameters: { type: 'object' } } };
const ask = (m: MockLLM, opts: { tools?: boolean } = {}) =>
  new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'x' }],
    ...(opts.tools && { tools: [tool] }),
  });
const behaviours = (m: MockLLM) => m.journal.all().map((e) => e.chaos?.behaviour ?? 'none');

describe('content chaos: each behaviour', () => {
  const only = async (behaviour: string, opts: { tools?: boolean; reply?: 'text' | 'tool' } = {}) => {
    const m = await start(1, { rate: 1, weights: { [behaviour]: 1 } });
    if (opts.reply === 'tool') m.default().replyToolCall('lookup', { id: 'A-1001', verbose: true });
    else m.default().reply('The full scripted answer, which is fairly long.');
    const r = await ask(m, { tools: opts.tools }).catch((e) => e);
    return { m, r };
  };

  it('refusal → a model refusal', async () => {
    const { m, r } = await only('refusal');
    expect(r.choices[0].message.refusal).toBeTruthy();
    expect(m.journal.last()!.chaos).toEqual({ seed: 1, behaviour: 'refusal' });
  });

  it('empty → no content', async () => {
    const { r } = await only('empty');
    expect(r.choices[0].message.content).toBe('');
  });

  it('truncated → the scripted text cut off at max_tokens', async () => {
    const { r } = await only('truncated');
    expect(r.choices[0].finish_reason).toBe('length');
    const text = r.choices[0].message.content as string;
    expect('The full scripted answer, which is fairly long.'.startsWith(text)).toBe(true);
    expect(text.length).toBeLessThan(48);
  });

  it('truncated on a tool-call reply → cut-off JSON arguments at max_tokens', async () => {
    const { r } = await only('truncated', { tools: true, reply: 'tool' });
    expect(r.choices[0].finish_reason).toBe('length');
    expect(() => JSON.parse(r.choices[0].message.tool_calls[0].function.arguments)).toThrow();
  });

  it('malformedToolCall → the scripted tool call keeps its name but gets invalid JSON', async () => {
    const { r } = await only('malformedToolCall', { tools: true, reply: 'tool' });
    const call = r.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe('lookup');
    expect(() => JSON.parse(call.function.arguments)).toThrow();
  });

  it('malformedToolCall without a scripted tool call → a broken call to the first offered tool', async () => {
    const { r } = await only('malformedToolCall', { tools: true });
    expect(r.choices[0].message.tool_calls[0].function.name).toBe('lookup');
  });

  it('malformedToolCall never applies when no tools are offered', async () => {
    const { m, r } = await only('malformedToolCall', { tools: false });
    expect(r.choices[0].message.content).toBe('The full scripted answer, which is fairly long.');
    expect(m.journal.last()!.chaos).toBeUndefined();
  });

  it('error → a fault from the pool (seed note, native error), recorded as behaviour "error"', async () => {
    const m = await start(5, { rate: 1, weights: { error: 1 }, faults: [faults.overloaded()] });
    m.default().reply('ok');
    const err = await ask(m).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).toContain('MOCK_LLM_SEED=5');
    expect(m.journal.last()!.chaos).toEqual({ seed: 5, behaviour: 'error' });
  });

  it('content chaos runs the matched rule (its sequence advances) and keeps matchedBy', async () => {
    const m = await start(1, { rate: 1, weights: { empty: 1 } });
    m.when({}, 'seq').reply('first').then.reply('second');
    await ask(m);
    m.chaos(null);
    expect((await ask(m)).choices[0]!.message.content).toBe('second'); // step 1 was consumed by the chaotic request
    expect(m.journal.all()[0]!.matchedBy).toBe('seq');
  });
});

describe('content chaos: reproducibility', () => {
  const run = async (seed: number) => {
    const m = await start(seed, { rate: 0.7, weights: { refusal: 1, empty: 1, truncated: 2, malformedToolCall: 1, error: 1 } });
    m.default().reply('A scripted answer with several words in it.');
    for (let i = 0; i < 24; i++) await ask(m, { tools: true }).catch(() => {});
    return behaviours(m);
  };

  it('the same seed produces the same sequence of behaviours', async () => {
    const a = await run(2024);
    expect(await run(2024)).toEqual(a);
    expect(await run(2025)).not.toEqual(a);
    expect(new Set(a)).toEqual(new Set(['none', 'refusal', 'empty', 'truncated', 'malformedToolCall', 'error'])); // all behaviours occur
  });

  it('a single candidate behaviour consumes no randomness (errors-only chaos keeps its pre-weights stream)', () => {
    const used = new Rng(2024);
    const untouched = new Rng(2024);
    expect(pickBehaviour({ rate: 1 }, { tools: [] } as any, used)).toBe('error');
    expect(pickBehaviour({ rate: 1, weights: { malformedToolCall: 1, refusal: 1 } }, { tools: [] } as any, used)).toBe('refusal'); // only applicable one
    expect(used.next()).toBe(untouched.next()); // stream unchanged
  });

  it('errors-only chaos sequence is pinned (golden, seed 2024)', async () => {
    // Recorded at R7f. Equal to the pre-weights behaviour because of the no-draw invariant above:
    // the random stream is consumed exactly as before (rate draw, then the fault-pool pick).
    const m = await start(2024, { rate: 0.5 });
    m.default().reply('ok');
    const actual: string[] = [];
    for (let i = 0; i < 16; i++) {
      await ask(m).catch(() => {});
      const e = m.journal.last()!;
      actual.push(e.fault?.type === 'error' ? e.fault.error.kind : 'ok');
    }
    expect(actual).toEqual(['ok', 'overloaded', 'ok', 'rate_limit', 'ok', 'ok', 'server', 'server', 'rate_limit', 'overloaded', 'ok', 'rate_limit', 'ok', 'ok', 'ok', 'ok']);
  });
});

describe('content chaos: validation', () => {
  it('rejects bad options with clear messages', async () => {
    await expect(createMockLLM({ chaos: { rate: 2 } })).rejects.toThrow(/rate must be a number between 0 and 1, got 2/);
    await expect(createMockLLM({ chaos: { rate: 0.5, weights: { gibberish: 1 } as any } })).rejects.toThrow(/unknown behaviour "gibberish"/);
    await expect(createMockLLM({ chaos: { rate: 0.5, weights: { refusal: -1 } } })).rejects.toThrow(/weights.refusal must be a number ≥ 0/);
    await expect(createMockLLM({ chaos: { rate: 0.5, weights: { refusal: 0 } } })).rejects.toThrow(/at least one behaviour with weight > 0/);
    const m = await createMockLLM();
    mocks.push(m);
    expect(() => m.chaos({ rate: 0.5, faults: [] })).toThrow(/faults must be a non-empty array/);
  });
});
