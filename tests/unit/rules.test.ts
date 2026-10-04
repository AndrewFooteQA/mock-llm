import { describe, expect, it } from 'vitest';
import { MockLLM } from '../../src/index.js';

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, json: (await r.json()) as any }),
  );
const chat = (content: string) => ({ model: 'gpt-4o', messages: [{ role: 'user', content }] });
const text = (r: { json: any }) => r.json.choices?.[0]?.message?.content;

describe('rule engine', () => {
  it('latest matching rule wins; exhausted rules fall through', async () => {
    const mock = await new MockLLM().start();
    try {
      mock.when({}).reply('base');
      mock.when({}).times(2).reply('override');
      const base = mock.urls.openai.replace(/\/v1$/, '');
      expect(text(await post(base, chat('a')))).toBe('override');
      expect(text(await post(base, chat('a')))).toBe('override');
      expect(text(await post(base, chat('a')))).toBe('base');
    } finally {
      await mock.stop();
    }
  });

  it('sequences advance and the last step repeats', async () => {
    const mock = await new MockLLM().start();
    try {
      mock.when({}).reply('1').reply('2');
      const base = mock.urls.base + '/openai';
      const got = [];
      for (let i = 0; i < 3; i++) got.push(text(await post(base, chat('x'))));
      expect(got).toEqual(['1', '2', '2']);
    } finally {
      await mock.stop();
    }
  });

  it('seeded lorem and chaos are reproducible', async () => {
    const run = async () => {
      const mock = await new MockLLM({ seed: 99, chaos: { rate: 0.5 } }).start();
      mock.default().replyLorem({ tokens: 8 });
      const out = [];
      for (let i = 0; i < 6; i++) {
        const r = await post(mock.urls.base, chat('x'));
        out.push(r.status === 200 ? text(r) : r.status);
      }
      await mock.stop();
      return out;
    };
    const a = await run();
    expect(await run()).toEqual(a);
    expect(a.some((x) => typeof x === 'number')).toBe(true);
  });

  it('onUnmatched: error and unknown scenarios fail loudly', async () => {
    const mock = await new MockLLM({ onUnmatched: 'error' }).start();
    try {
      expect((await post(mock.urls.base, chat('x'))).status).toBe(400);
      const r = await post(mock.urls.base, chat('x'), { 'x-mock-scenario': 'nope' });
      expect(r.json.error.message).toContain('unknown scenario');
    } finally {
      await mock.stop();
    }
  });

  it('exposes the journal over HTTP for out-of-process clients', async () => {
    const mock = await new MockLLM().start();
    try {
      await post(mock.urls.base, chat('ping'));
      const j = (await (await fetch(`${mock.urls.base}/__mock/journal`)).json()) as any[];
      expect(j[0].request.messages[0].content[0].text).toBe('ping');
    } finally {
      await mock.stop();
    }
  });

  it('records unknown routes as endpoint "unknown", not "chat"', async () => {
    const mock = await new MockLLM().start();
    try {
      const r = await fetch(`${mock.urls.anthropic}/api/hello`, { method: 'HEAD' }); // Claude Code's connectivity probe
      expect(r.status).toBe(404);
      await post(mock.urls.base, chat('x'));
      expect(mock.journal.all().map((e) => e.endpoint)).toEqual(['unknown', 'chat']);
      expect(mock.journal.count({ endpoint: 'chat' })).toBe(1);
    } finally {
      await mock.stop();
    }
  });
});
