import { BedrockRuntimeClient, ThrottlingException } from '@aws-sdk/client-bedrock-runtime';
import { createMockLLM, edge, faults, type MockLLM } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { MODEL_ID, streamWithInvokeModel, SummaryInterrupted, summarize, summarizeOnce, summarizeWithInvokeModel, SYSTEM_PROMPT } from '../src/summarize.js';

const mock = useMockLLM();
const SUMMARY = 'The report covers Q3 results. Revenue grew twelve percent. Costs were flat.';

// The AWS SDK speaks HTTP/2 to Bedrock; mock-llm serves both on one port.
const client = (m: MockLLM = mock, maxAttempts = 1) =>
  new BedrockRuntimeClient({ endpoint: m.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts });

describe('summarize', () => {
  it('streams the summary token by token', async () => {
    mock.when({}).reply(SUMMARY);
    const tokens: string[] = [];
    const result = await summarize(client(), 'long document…', (t) => tokens.push(t));

    expect(result).toMatchObject({ text: SUMMARY, stopReason: 'end_turn' });
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(tokens.length).toBeGreaterThan(5);
    expect(tokens.join('')).toBe(SUMMARY);
  });

  it('sends the right model, system prompt and document', async () => {
    mock.when({}).reply(SUMMARY);
    await summarize(client(), 'THE DOCUMENT');
    expect(mock).toHaveReceivedRequest({
      provider: 'bedrock',
      model: MODEL_ID,
      system: SYSTEM_PROMPT,
      stream: true,
      maxTokens: 512,
      lastUserMessage: 'THE DOCUMENT',
    });
  });

  it('keeps partial text when the connection drops mid-stream', async () => {
    mock.when({}).fail(faults.streamCut({ afterChunks: 6, response: { content: [{ type: 'text', text: SUMMARY }] } }));
    const err = await summarize(client(), 'doc').catch((e) => e);
    expect(err).toBeInstanceOf(SummaryInterrupted);
    expect(SUMMARY.startsWith(err.partial)).toBe(true);
    expect(err.partial.length).toBeGreaterThan(0);
  });

  it('surfaces in-stream throttling exceptions', async () => {
    mock.when({}).fail(faults.streamError({ afterChunks: 4, error: { kind: 'rate_limit' } }));
    const err = await summarize(client(), 'doc').catch((e) => e);
    expect(err).toBeInstanceOf(SummaryInterrupted);
    expect(err.cause).toBeInstanceOf(ThrottlingException);
  });

  it('recovers from request-level throttling via SDK retries', async () => {
    mock.when({}).reply(SUMMARY);
    mock.when({}).once().fail(faults.rateLimit());
    const result = await summarize(client(mock, 3), 'doc');
    expect(result.text).toBe(SUMMARY);
    expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]);
  });

  it('mock events show each binary event-stream frame as it is sent', async () => {
    mock.when({}).reply(SUMMARY);
    const events: string[] = [];
    const frames: string[] = [];
    const onChunk = ({ text }: { text: string }) => {
      events.push('chunk');
      frames.push(text);
    };
    const onRequest = () => events.push('request');
    const onResponse = () => events.push('response');
    mock.on('request', onRequest).on('chunk', onChunk).on('response', onResponse);
    try {
      await summarize(client(), 'doc');
    } finally {
      mock.off('request', onRequest).off('chunk', onChunk).off('response', onResponse);
    }
    expect(events[0]).toBe('request');
    expect(events.at(-1)).toBe('response');
    expect(frames[0]).toMatch(/event:messageStart/); // decoded from AWS binary framing
    expect(frames.some((f) => f.includes('event:metadata'))).toBe(true);
  });

  it('per-rule random latency is seeded and recorded on the journal', async () => {
    mock.when({}).latency({ firstTokenMs: { min: 60, max: 120 } }).reply(SUMMARY);
    const started = Date.now();
    let firstTokenAt = 0;
    await summarize(client(), 'doc', () => (firstTokenAt ||= Date.now()));

    const applied = mock.journal.last()!.latency!.firstTokenMs;
    expect(applied).toBeGreaterThanOrEqual(60);
    expect(applied).toBeLessThanOrEqual(120);
    expect(firstTokenAt - started).toBeGreaterThanOrEqual(applied - 5); // never earlier than the recorded delay
  });

  it("reports a mid-stream cut as a 'fault' event, and the wire record shows the partial stream", async () => {
    mock.when({}).fail(faults.streamCut({ afterChunks: 4, response: { content: [{ type: 'text', text: SUMMARY }] } }));
    const faultsSeen: string[] = [];
    const onFault = ({ fault }: { fault: { type: string } }) => faultsSeen.push(fault.type);
    mock.on('fault', onFault);
    try {
      await summarize(client(), 'doc').catch(() => {});
    } finally {
      mock.off('fault', onFault);
    }
    expect(faultsSeen).toEqual(['stream_cut']);
    // The raw exchange is on the journal entry (recordWire is on by default): Bedrock's binary frames, decoded.
    const wire = mock.journal.last()!.wire!;
    expect(wire.request.body).toContain('"text":"doc"');
    expect(wire.response.body).toContain('event:messageStart');
    expect(wire.response.body).not.toContain('event:messageStop'); // cut before the end
  });

  it('a slow first step (per-step delay) is recorded on the journal', async () => {
    mock.when({}).reply(SUMMARY, { delay: 120 }).then.reply(SUMMARY);
    const t = Date.now();
    await summarize(client(), 'doc');
    expect(Date.now() - t).toBeGreaterThanOrEqual(110); // lower bound only: wall-clock upper bounds are flaky in CI
    await summarize(client(), 'doc');
    expect(mock.journal.all().map((e) => e.latency?.firstTokenMs)).toEqual([120, 0]); // recorded per request
  });

  it('works with realistic latency (time to first token)', async () => {
    // A dedicated mock with latency, so the other tests stay fast.
    const slow = await createMockLLM({ latency: { firstTokenMs: 150, tokensPerSec: 200 } });
    try {
      slow.default().reply(SUMMARY);
      const started = Date.now();
      let firstTokenAt = 0;
      await summarize(client(slow), 'doc', () => (firstTokenAt ||= Date.now()));
      expect(firstTokenAt - started).toBeGreaterThanOrEqual(140);
    } finally {
      await slow.stop();
    }
  });
});

describe.each([
  ['Converse', summarizeOnce],
  ['InvokeModel (Claude Messages body)', summarizeWithInvokeModel],
])('non-streaming summary via %s', (_api, run) => {
  it('returns the whole summary and sends the length limit', async () => {
    mock.when({}).reply(SUMMARY);
    expect(await run(client(), 'Q3 report…', { maxTokens: 200 })).toEqual({ text: SUMMARY, stopReason: 'end_turn', truncated: false });
    expect(mock).toHaveReceivedRequest({ provider: 'bedrock', model: MODEL_ID, system: SYSTEM_PROMPT, maxTokens: 200, stream: false });
  });

  it('marks a summary cut off at max_tokens as truncated', async () => {
    mock.when({}).reply(edge.truncated(SUMMARY));
    const summary = await run(client(), 'Q3 report…', { maxTokens: 20 });
    expect(summary).toMatchObject({ stopReason: 'max_tokens', truncated: true });
    expect(SUMMARY.startsWith(summary.text)).toBe(true);
  });
});

describe('streamed summary via InvokeModelWithResponseStream (Claude stream events)', () => {
  it('streams the native Claude events token by token', async () => {
    mock.when({}).reply(SUMMARY);
    const tokens: string[] = [];
    const summary = await streamWithInvokeModel(client(), 'Q3 report…', (t) => tokens.push(t));
    expect(summary).toEqual({ text: SUMMARY, stopReason: 'end_turn', truncated: false });
    expect(tokens.length).toBeGreaterThan(1);
    expect(mock).toHaveReceivedRequest({ provider: 'bedrock', stream: true, system: SYSTEM_PROMPT });
  });
});
