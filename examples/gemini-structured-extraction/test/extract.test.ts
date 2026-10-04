import { GoogleGenAI } from '@google/genai';
import { edge } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';
import { describe, expect, it } from 'vitest';
import { ExtractionError, extractInvoice, INVOICE_SCHEMA, validateInvoice } from '../src/extract.js';

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
