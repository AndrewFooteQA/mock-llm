import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockLLM, envFor, RemoteMockLLM, remoteAssertions, UnmatchedRequestError, urlsFor, type MockLLM } from '../../src/index.js';
import { providerRewrite } from '../../src/testing/playwright.js';

let mock: MockLLM;
afterEach(async () => mock?.stop());

const ask = (baseUrl: string, content: string, extra: Record<string, unknown> = {}) =>
  new OpenAI({ baseURL: urlsFor(baseUrl).openai, apiKey: 'k', maxRetries: 0 }).chat.completions.create({
    model: 'claude-opus-5-5', // priced, to exercise remote cost
    messages: [{ role: 'user', content }],
    ...extra,
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);

describe('HTTP control API + RemoteMockLLM', () => {
  it('loads scenarios, snapshots the journal with pricing, and resets', async () => {
    mock = await createMockLLM({ pricing: { 'custom-model': { input: 1, output: 1 } } });
    const remote = new RemoteMockLLM(mock.urls.base + '/'); // trailing slash tolerated

    await remote.load({ rules: [{ when: { lastUserMessage: 'refund' }, reply: 'Refunds take 5 days.' }] });
    expect((await ask(remote.baseUrl, 'refund?')).choices[0]!.message.content).toBe('Refunds take 5 days.');

    const info = await remote.info();
    expect(info.urls).toEqual(mock.urls);
    expect(info.pricing['custom-model']).toEqual({ input: 1, output: 1 });
    expect(info.pricing['claude-opus-5-5']).toBeDefined();

    const journal = await remote.journal();
    expect(journal.count()).toBe(1);
    expect(journal.last()!.request.messages[0]!.content[0]).toEqual({ type: 'text', text: 'refund?' });
    expect(journal.cost().byModel['claude-opus-5-5']!.usd).toBeGreaterThan(0); // priced with the remote table

    await remote.reset();
    expect((await remote.journal()).count()).toBe(0);
    expect((await ask(remote.baseUrl, 'refund?')).choices[0]!.message.content).toContain('mock'); // rules cleared too
  });

  it('rejects invalid scenarios with the validation message (400)', async () => {
    mock = await createMockLLM();
    await expect(new RemoteMockLLM(mock.urls.base).load({ rules: [{ when: { lastUserMesage: 'x' }, reply: 'y' }] } as any)).rejects.toThrow(
      /control POST \/__mock\/load failed \(400\): .*unknown matcher 'lastUserMesage'/,
    );
  });

  it('reports unknown control endpoints (404) and unreachable mocks clearly', async () => {
    mock = await createMockLLM();
    const r = await fetch(`${mock.urls.base}/__mock/nope`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.message).toContain('unknown mock-llm control endpoint: GET /__mock/nope');
    await expect(new RemoteMockLLM('http://127.0.0.1:1').info()).rejects.toThrow(/cannot reach the mock at http:\/\/127\.0\.0\.1:1/);
  });

  it('a server that is not a mock (non-JSON reply) gets a clear error, not a bare SyntaxError', async () => {
    const other = createServer((_req, res) => res.writeHead(502, { 'content-type': 'text/html' }).end('<html>Bad Gateway</html>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      await expect(new RemoteMockLLM(url).info()).rejects.toThrow(`mock-llm control GET /__mock/info failed (502): non-JSON reply: "<html>Bad Gateway</html>". Is ${url} a mock-llm server?`);
    } finally {
      other.close();
    }
  });

  it('remote assertions run the same core against a snapshot', async () => {
    mock = await createMockLLM();
    const remote = new RemoteMockLLM(mock.urls.base);
    await remote.load({ rules: [{ when: { tool: 'lookup' }, toolCall: { name: 'lookup', input: { id: 7 } } }] });
    await ask(remote.baseUrl, 'find 7', { tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] });

    expect((await remoteAssertions.toHaveOfferedTool(remote, 'lookup')).pass).toBe(true);
    expect((await remoteAssertions.toHaveRequestedTool(remote, 'lookup', { id: 7 })).pass).toBe(true);
    expect((await remoteAssertions.toHaveReceivedRequestTimes(remote, 1)).pass).toBe(true);
    expect((await remoteAssertions.toCostLessThan(remote, 1)).pass).toBe(true);
    const fail = await remoteAssertions.toHaveToolTrajectory(remote, ['lookup'], { source: 'requested', mode: 'exact' });
    expect(fail.pass).toBe(true);
    const miss = await remoteAssertions.toHaveOfferedTool(remote, 'delete');
    expect(miss.pass).toBe(false);
    expect(miss.message()).toContain('Expected mock-llm to have offered tool "delete"');
    // Local targets work too:
    expect((await remoteAssertions.toHaveOfferedTool(mock, 'lookup')).pass).toBe(true);
  });

  it('assertNoUnmatched works remotely (strict check from another process)', async () => {
    mock = await createMockLLM({ strict: true });
    const remote = new RemoteMockLLM(mock.urls.base);
    await ask(remote.baseUrl, 'unscripted').catch(() => {});
    await expect(remote.assertNoUnmatched()).rejects.toBeInstanceOf(UnmatchedRequestError);
    await expect(remote.assertNoUnmatched()).rejects.toThrow(/UNEXPECTED LLM REQUEST[\s\S]*lastUserMessage: "unscripted"/);
    expect((await remote.info()).strict).toBe(true);
  });
});

describe('urlsFor / envFor', () => {
  it('derive SDK URLs and env vars from a base URL alone (no running mock)', () => {
    expect(urlsFor('http://127.0.0.1:4010/')).toEqual({
      base: 'http://127.0.0.1:4010',
      openai: 'http://127.0.0.1:4010/openai/v1',
      anthropic: 'http://127.0.0.1:4010/anthropic',
      gemini: 'http://127.0.0.1:4010/gemini',
      bedrock: 'http://127.0.0.1:4010/bedrock',
    });
    expect(envFor('http://127.0.0.1:4010')).toMatchObject({
      OPENAI_BASE_URL: 'http://127.0.0.1:4010/openai/v1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010/anthropic',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'http://127.0.0.1:4010/bedrock',
    });
  });

  it('mock.env() equals envFor(mock.urls.base)', async () => {
    mock = await createMockLLM();
    expect(mock.env()).toEqual(envFor(mock.urls.base));
  });
});

describe('providerRewrite (browser routing)', () => {
  const base = 'http://127.0.0.1:4010';
  it.each([
    ['https://api.openai.com/v1/chat/completions', `${base}/openai/v1/chat/completions`],
    ['https://api.x.ai/v1/chat/completions', `${base}/openai/v1/chat/completions`],
    ['https://api.anthropic.com/v1/messages', `${base}/anthropic/v1/messages`],
    [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      `${base}/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
    ],
    ['https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-sonnet-5-5/converse', `${base}/bedrock/model/anthropic.claude-sonnet-5-5/converse`],
  ])('%s → mock', (from, to) => expect(providerRewrite(from, base)).toBe(to));

  it('leaves non-provider URLs alone', () => {
    expect(providerRewrite('https://example.com/v1/chat/completions', base)).toBeNull();
    expect(providerRewrite('https://s3.us-east-1.amazonaws.com/bucket', base)).toBeNull();
  });
});
