import { afterEach, describe, expect, it } from 'vitest';
import { createMockLLM, RemoteMockLLM, type MockLLM } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';

const FILE = 'tests/fixtures/support-bot.yaml';

const ask = async (m: { urls: { openai: string } } | string, content: string) => {
  const base = typeof m === 'string' ? m : m.urls.openai;
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content }] }),
  });
  const json = (await r.json()) as any;
  return r.status === 200 ? json.choices[0].message.content : r.status;
};

describe('useMockLLM({ scenarioFiles }): file rules apply in every test, not just the first', () => {
  const mock = useMockLLM({ scenarioFiles: [FILE] });

  it('first test sees the file rules', async () => {
    expect(await ask(mock, 'refund please')).toBe('Refunds take 5 business days.');
    expect(await ask(mock, 'flaky')).toBe(429); // `once: true`
    expect(await ask(mock, 'flaky')).toBe('Sorry, I can only help with refunds.');
  });

  it('second test (after the reset) sees them too, with sequences and once-rules starting over', async () => {
    expect(await ask(mock, 'refund please')).toBe('Refunds take 5 business days.');
    expect(await ask(mock, 'flaky')).toBe(429);
  });
});

describe('reset() and scenarioFiles', () => {
  let mock: MockLLM;
  afterEach(async () => mock?.stop());

  it('re-applies scenarioFiles but clears when() rules and load()ed files', async () => {
    mock = await createMockLLM({ scenarioFiles: [FILE] });
    mock.when('refund').reply('per-test override');
    await mock.load({ rules: [{ when: { lastUserMessage: 'loaded' }, reply: 'from load()' }] });
    expect(await ask(mock, 'refund')).toBe('per-test override');
    expect(await ask(mock, 'loaded')).toBe('from load()');

    mock.reset();
    expect(await ask(mock, 'refund')).toBe('Refunds take 5 business days.');
    expect(await ask(mock, 'loaded')).toBe('Sorry, I can only help with refunds.'); // the file's default
    expect(mock.journal.count()).toBe(2);
  });

  it('the control API reset (Playwright fixture) keeps them too', async () => {
    mock = await createMockLLM({ scenarioFiles: [FILE] });
    const remote = new RemoteMockLLM(mock.urls.base);
    await remote.reset();
    expect(await ask(mock, 'refund')).toBe('Refunds take 5 business days.');
  });
});
