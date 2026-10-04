import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockLLM, faults, RemoteMockLLM, toHaveOfferedTool, type MockLLM, type MockLLMOptions } from '../../src/index.js';

let mocks: MockLLM[] = [];
let savedSeed: string | undefined;
beforeEach(() => {
  savedSeed = process.env.MOCK_LLM_SEED;
  delete process.env.MOCK_LLM_SEED;
});
afterEach(async () => {
  if (savedSeed === undefined) delete process.env.MOCK_LLM_SEED;
  else process.env.MOCK_LLM_SEED = savedSeed;
  await Promise.all(mocks.map((m) => m.stop()));
  mocks = [];
});
const start = async (opts: MockLLMOptions = {}) => {
  const m = await createMockLLM(opts);
  mocks.push(m);
  return m;
};
const openai = (m: MockLLM) => new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 });
const ask = (m: MockLLM, content = 'hi') => openai(m).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content }] });
const lorem = async (m: MockLLM) => {
  m.default().replyLorem({ tokens: 8 });
  return (await ask(m)).choices[0]!.message.content;
};

describe('effective seed', () => {
  it('defaults to 1, uses the seed option, and is exposed as mock.seed', async () => {
    expect((await start()).seed).toBe(1);
    expect((await start({ seed: 42 })).seed).toBe(42);
  });

  it('MOCK_LLM_SEED overrides the seed option (reproduce a CI run locally)', async () => {
    process.env.MOCK_LLM_SEED = '99';
    const fromEnv = await start({ seed: 5 });
    expect(fromEnv.seed).toBe(99);
    delete process.env.MOCK_LLM_SEED;
    const fromOption = await start({ seed: 99 });
    expect(await lorem(fromEnv)).toBe(await lorem(fromOption)); // same content as seed 99
    expect((await start({ seed: 5 })).seed).toBe(5);
  });

  it('rejects a non-integer MOCK_LLM_SEED clearly; ignores an empty one', async () => {
    process.env.MOCK_LLM_SEED = 'abc';
    await expect(createMockLLM()).rejects.toThrow(/MOCK_LLM_SEED must be an integer, got "abc"/);
    process.env.MOCK_LLM_SEED = '  ';
    expect((await start({ seed: 3 })).seed).toBe(3);
  });

  it('is reported by the control API and carried into remote journal snapshots', async () => {
    const m = await start({ seed: 1234 });
    const remote = new RemoteMockLLM(m.urls.base);
    expect((await remote.info()).seed).toBe(1234);
    expect((await remote.journal()).seed).toBe(1234);
  });
});

describe('seed in strict-mode failure messages', () => {
  it('local and remote UNEXPECTED LLM REQUEST reports say how to reproduce', async () => {
    const m = await start({ strict: true, seed: 77 });
    await ask(m, 'unscripted').catch(() => {});
    expect(() => m.assertNoUnmatched()).toThrow(/mock-llm seed: 77 \(reproduce this run with MOCK_LLM_SEED=77\)/);
    await expect(new RemoteMockLLM(m.urls.base).assertNoUnmatched()).rejects.toThrow(/MOCK_LLM_SEED=77/);
  });
});

describe('seed in chaos-related failure messages', () => {
  it('the error the app receives from a chaos fault names the seed (native type and envelope kept)', async () => {
    const m = await start({ seed: 31, chaos: { rate: 1, faults: [faults.overloaded()] } });
    const oa = await ask(m).catch((e) => e);
    expect(oa).toBeInstanceOf(OpenAI.InternalServerError);
    expect(oa.status).toBe(503);
    expect(oa.message).toContain('[mock-llm chaos fault · seed 31 · reproduce with MOCK_LLM_SEED=31]');

    const an = await new Anthropic({ baseURL: m.urls.anthropic, apiKey: 'k', maxRetries: 0 })
      .messages.create({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(an.status).toBe(529);
    expect(an.error).toMatchObject({ error: { type: 'overloaded_error', message: expect.stringContaining('MOCK_LLM_SEED=31') } });
    expect(m.journal.all().map((e) => e.chaos)).toEqual([{ seed: 31, behaviour: 'error' }, { seed: 31, behaviour: 'error' }]);
  });

  it('non-chaos faults keep the exact native message', async () => {
    const m = await start({ seed: 31 });
    m.when({}).fail(faults.overloaded());
    const err = await ask(m).catch((e) => e);
    expect(err.message).not.toContain('mock-llm chaos');
    expect(m.journal.last()!.chaos).toBeUndefined();
  });

  it('matcher failure excerpts add a reproduction hint when chaos affected a request', async () => {
    const m = await start({ seed: 8, chaos: { rate: 1, faults: [faults.serverError()] } });
    await ask(m).catch(() => {});
    const msg = toHaveOfferedTool(m, 'search').message();
    expect(msg).toContain('mock fault: error (chaos)');
    expect(msg).toContain('Chaos affected 1 request(s): reproduce with MOCK_LLM_SEED=8');

    const calm = await start({ seed: 8 });
    calm.default().reply('ok');
    await ask(calm);
    expect(toHaveOfferedTool(calm, 'search').message()).not.toContain('MOCK_LLM_SEED');
  });

  it('a chaos run is reproducible: same seed → same sequence of outcomes', async () => {
    const outcomes = async (seed: number) => {
      const m = await start({ seed, chaos: { rate: 0.5, faults: [faults.overloaded()] } });
      m.default().reply('ok');
      const out: string[] = [];
      for (let i = 0; i < 12; i++) out.push(await ask(m).then(() => 'ok', () => 'fault'));
      return out.join(' ');
    };
    const a = await outcomes(2024);
    expect(await outcomes(2024)).toBe(a);
    expect(a).toContain('ok');
    expect(a).toContain('fault');
  });
});
