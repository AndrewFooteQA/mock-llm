import { GoogleGenAI } from '@google/genai';
import { OAuth2Client } from 'google-auth-library';
import { edge, fakeFromSchema, faults } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { ExtractionError, extractInvoice, extractInvoiceStreaming, INVOICE_SCHEMA, validateInvoice } from '../src/extract.js';

const mock = useMockLLM({ seed: 42 });
const ai = () => new GoogleGenAI({ apiKey: 'test', httpOptions: { baseUrl: mock.urls.gemini } });

const INVOICE = {
  vendor: 'Acme Corp',
  invoiceNumber: 'INV-42',
  total: 1250,
  currency: 'USD',
  lineItems: [{ description: 'Widgets', amount: 1250 }],
};

describe('extractInvoice', () => {
  it('returns the parsed invoice (scripted exact JSON)', async () => {
    mock.when({ responseFormat: 'json_schema' }).replyJson(INVOICE);
    const { invoice, attempts } = await extractInvoice(ai(), 'Invoice INV-42 from Acme…');
    expect(invoice).toEqual(INVOICE);
    expect(attempts).toBe(1);
  });

  it('sends the schema with the request', async () => {
    mock.when({}).replyJson(INVOICE);
    await extractInvoice(ai(), 'text');
    expect(mock).toHaveReceivedRequest({ responseFormat: { type: 'json_schema', schema: INVOICE_SCHEMA } });
  });

  it('accepts any schema-valid output (generated from the request schema)', async () => {
    mock.when({ responseFormat: 'json_schema' }).replyFromSchema();
    const { invoice } = await extractInvoice(ai(), 'text');
    expect(validateInvoice(invoice)).toEqual([]);
  });

  it('retries once when the output violates the schema', async () => {
    mock.when({}).replyFromSchema({ violate: true }).then.replyFromSchema();
    const { attempts } = await extractInvoice(ai(), 'text');
    expect(attempts).toBe(2);
    // The retry prompt told the model what was wrong.
    expect(mock).toHaveReceivedPrompt('previous answer was invalid', { in: 'lastUser' });
  });

  it('tolerates JSON wrapped in a markdown code fence', async () => {
    mock.when({}).reply(edge.codeFencedJson(INVOICE));
    expect((await extractInvoice(ai(), 'text')).invoice).toEqual(INVOICE);
  });

  it('gives up after maxAttempts of invalid output', async () => {
    mock.when({}).reply(edge.almostJson({ vendor: 'Acme' }));
    await expect(extractInvoice(ai(), 'text')).rejects.toBeInstanceOf(ExtractionError);
    expect(mock).toHaveReceivedRequestTimes(2);
  });

  it('treats truncated output as invalid and retries', async () => {
    mock.when({}).reply(edge.truncated(JSON.stringify(INVOICE))).then.replyJson(INVOICE);
    expect((await extractInvoice(ai(), 'text')).attempts).toBe(2);
  });

  it('fails fast on safety blocks', async () => {
    mock.when({}).reply(edge.contentFilter());
    await expect(extractInvoice(ai(), 'text')).rejects.toThrow(/safety/);
    expect(mock).toHaveReceivedRequestTimes(1);
  });
});

describe('validateInvoice (fixtures generated from the schema)', () => {
  // The same generator the mock uses for replyFromSchema, called directly: deterministic per seed.
  it.each([1, 2, 3, 4, 5])('accepts a schema-valid invoice and rejects a violating one (seed %i)', (seed) => {
    expect(validateInvoice(fakeFromSchema(INVOICE_SCHEMA, { seed }))).toEqual([]);
    expect(validateInvoice(fakeFromSchema(INVOICE_SCHEMA, { seed, violate: true })).length).toBeGreaterThan(0);
  });
});

describe('extractInvoiceStreaming', () => {
  it('assembles the streamed JSON, reporting progress as it arrives', async () => {
    // Exact chunks: the JSON arrives in fragments, as it does from the real API.
    const json = JSON.stringify(INVOICE);
    const thirds = [json.slice(0, 30), json.slice(30, 80), json.slice(80)];
    mock.when({}).reply({ chunks: thirds });

    const progress: number[] = [];
    const invoice = await extractInvoiceStreaming(ai(), 'Invoice INV-42 from Acme…', { onProgress: (n) => progress.push(n) });
    expect(invoice).toEqual(INVOICE);
    expect(progress).toEqual([30, 80, json.length]);
    expect(mock).toHaveReceivedRequest({ stream: true, responseFormat: { type: 'json_schema' } });
  });

  it('reports a stream that fails part-way instead of returning a partial invoice', async () => {
    // Two chunks of the stream, then Gemini's native in-stream error (overloaded = 503 UNAVAILABLE).
    mock.when({}).fail(faults.streamError({ afterChunks: 2, error: { kind: 'overloaded' } }));

    const err = await extractInvoiceStreaming(ai(), 'text').catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.message).toMatch(/stopped part-way through the response \(HTTP 503\)/);
    expect(mock.journal.last()!.fault).toMatchObject({ type: 'stream_error' });
  });
});

describe('Vertex AI', () => {
  it('extracts through a Vertex AI client too (OAuth instead of an API key, project-scoped paths)', async () => {
    // A static OAuth token: the SDK sends `Authorization: Bearer …` without looking up Google credentials.
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: 'test-token', expiry_date: Date.now() + 3_600_000 });
    const vertex = new GoogleGenAI({ vertexai: true, project: 'my-project', location: 'europe-west4', googleAuthOptions: { authClient }, httpOptions: { baseUrl: mock.urls.gemini } });
    mock.when({ responseFormat: 'json_schema' }).replyJson(INVOICE);

    const { invoice } = await extractInvoice(vertex, 'Invoice INV-42 from Acme…');
    expect(invoice).toEqual(INVOICE);
    expect(mock).toHaveReceivedRequest({ provider: 'gemini', headers: { authorization: 'Bearer test-token' } });
    expect(mock.journal.last()!.path).toContain('/projects/my-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent');
  });
});
