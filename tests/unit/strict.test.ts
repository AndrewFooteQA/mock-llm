import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockLLM, faults, UnmatchedRequestError, type MockLLM } from '../../src/index.js';
import '../../src/testing/vitest.js';

let mock: MockLLM;
afterEach(async () => mock?.stop());

const openai = (m: MockLLM) => new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 2 });
const ask = (m: MockLLM, content: string, extra: Record<string, unknown> = {}) =>
  openai(m).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content }], ...extra } as OpenAI.ChatCompletionCreateParamsNonStreaming);

describe('strict mode', () => {
  it('gives unmatched chat requests a native, non-retried 400 and flags them', async () => {
    mock = await createMockLLM({ strict: true });
    mock.when('refund').reply('Refunds take 5 days.');

    expect((await ask(mock, 'refund please')).choices[0]!.message.content).toBe('Refunds take 5 days.');
    const err = await ask(mock, 'Where is my order?').catch((e) => e);
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect(err.message).toContain('mock-llm strict mode: no rule matched');

    // maxRetries: 2, yet exactly one request: 400s are never retried.
    expect(mock.journal.all().map((e) => [e.status, !!e.unmatched])).toEqual([
      [200, false],
      [400, true],
    ]);
  });

  it('uses each provider’s native error type (Anthropic)', async () => {
    mock = await createMockLLM({ strict: true });
    const claude = new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'k', maxRetries: 0 });
    const err = await claude.messages.create({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err.error).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });

  it('counts default(), rules and scenarios as matched', async () => {
    mock = await createMockLLM({ strict: true });
    mock.default().reply('fallback');
    await ask(mock, 'anything');
    await ask(mock, 'hi [[mock:unicode]]');
    expect(mock.journal.all().some((e) => e.unmatched)).toBe(false);
    expect(() => mock.assertNoUnmatched()).not.toThrow();
  });

  it('never counts non-chat endpoints (models, count_tokens, embeddings)', async () => {
    mock = await createMockLLM({ strict: true });
    for await (const _ of openai(mock).models.list());
    await openai(mock).embeddings.create({ model: 'text-embedding-3-small', input: 'x' });
    const claude = new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'k' });
    await claude.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] });
    expect(mock.journal.count()).toBe(3);
    expect(() => mock.assertNoUnmatched()).not.toThrow();
  });

  it('chaos faults still count as unmatched when nothing scripted the request', async () => {
    // retryAfter: 0 → the SDK retries immediately (deterministic; no exponential backoff in the test).
    mock = await createMockLLM({ strict: true, chaos: { rate: 1, faults: [faults.serverError({ retryAfter: 0 })] } });
    await ask(mock, 'x').catch(() => {});
    expect(mock.journal.all().map((e) => e.unmatched)).toEqual([true, true, true]); // 500 → SDK retried twice
    await mock.stop();

    mock = await createMockLLM({ strict: true, chaos: { rate: 1, faults: [faults.serverError({ retryAfter: 0 })] } });
    mock.when({}).reply('ok');
    await ask(mock, 'x').catch(() => {});
    expect(mock.journal.all().some((e) => e.unmatched)).toBe(false);
  });

  it('non-strict mode still flags unmatched requests (canned reply, no error)', async () => {
    mock = await createMockLLM();
    expect((await ask(mock, 'hello')).choices[0]!.message.content).toContain('mock');
    expect(mock.journal.last()!.unmatched).toBe(true);
    expect(() => mock.assertNoUnmatched()).toThrow(UnmatchedRequestError);
  });
});

describe('assertNoUnmatched report', () => {
  it('lists provider, model, prompt, tools and a suggested rule per request', async () => {
    mock = await createMockLLM({ strict: true });
    await ask(mock, 'Where is my order A-1001?', {
      messages: [{ role: 'system', content: 'You are Acme support.' }, { role: 'user', content: 'Where is my order A-1001?' }],
      tools: [{ type: 'function', function: { name: 'lookup_order', parameters: { type: 'object' } } }],
    }).catch(() => {});

    let message = '';
    try {
      mock.assertNoUnmatched();
    } catch (e) {
      expect(e).toBeInstanceOf(UnmatchedRequestError);
      message = (e as Error).message;
    }
    expect(message).toContain('UNEXPECTED LLM REQUEST: 1 request(s) matched no rule.');
    expect(message).toMatch(/#\d+ openai gpt-4o/);
    expect(message).toContain('system: "You are Acme support."');
    expect(message).toContain('last user: "Where is my order A-1001?"');
    expect(message).toContain('tools offered: lookup_order');
    expect(message).toContain(`add: mock.when({ provider: 'openai', lastUserMessage: "Where is my order A-1001?" }).reply('…');`);
    expect(message).toContain('mock.default().reply(...)');
  });

  it('suggests hasToolResult for an unscripted agent-loop continuation', async () => {
    mock = await createMockLLM({ strict: true });
    mock.when({ hasToolResult: false }).replyToolCall('lookup_order', { order_id: 'A-1' });
    const c = openai(mock);
    const first = await c.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'order?' }], tools: [{ type: 'function', function: { name: 'lookup_order', parameters: { type: 'object' } } }] });
    const call = first.choices[0]!.message.tool_calls![0]!;
    await c.chat.completions
      .create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'order?' }, first.choices[0]!.message, { role: 'tool', tool_call_id: call.id, content: '{}' }] })
      .catch(() => {});
    expect(() => mock.assertNoUnmatched()).toThrow(/hasToolResult: true/);
  });
});

describe('toHaveNoUnmatchedRequests matcher', () => {
  it('passes, fails with the report, supports .not and filters', async () => {
    mock = await createMockLLM();
    mock.when({ provider: 'openai' }).reply('ok');
    await ask(mock, 'hi');
    expect(mock).toHaveNoUnmatchedRequests();
    expect(() => expect(mock).not.toHaveNoUnmatchedRequests()).toThrow(/every one of 1 request\(s\) matched a rule/);

    const claude = new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'k' });
    await claude.messages.create({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(() => expect(mock).toHaveNoUnmatchedRequests()).toThrow(/UNEXPECTED LLM REQUEST/);
    expect(mock).not.toHaveNoUnmatchedRequests();
    expect(mock).toHaveNoUnmatchedRequests({ provider: 'openai' });
  });
});

describe('useMockLLM({ strict: true })', () => {
  it('fails a test whose app swallowed the error, and passes a scripted one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-llm-strict-'));
    const outputFile = join(dir, 'report.json');
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/fixtures/strict/vitest.config.ts', '--reporter=json', `--outputFile=${outputFile}`],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.status).toBe(1); // the suite fails…
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    rmSync(dir, { recursive: true, force: true });
    const results = Object.fromEntries(report.testResults[0].assertionResults.map((t: any) => [t.title, t]));
    // …because of exactly the swallowed request:
    expect(results['unscripted request is swallowed by the app'].status).toBe('failed');
    expect(results['unscripted request is swallowed by the app'].failureMessages.join('\n')).toContain('UNEXPECTED LLM REQUEST');
    expect(results['scripted request passes'].status).toBe('passed');
  });
});
