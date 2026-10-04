import type { GoogleGenAI } from '@google/genai';

export interface Invoice {
  vendor: string;
  invoiceNumber: string;
  total: number;
  currency: 'USD' | 'EUR' | 'GBP';
  lineItems: Array<{ description: string; amount: number }>;
}

export const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: 'string' },
    invoiceNumber: { type: 'string' },
    total: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
    lineItems: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, amount: { type: 'number' } },
        required: ['description', 'amount'],
      },
    },
  },
  required: ['vendor', 'invoiceNumber', 'total', 'currency', 'lineItems'],
} as const;

export class ExtractionError extends Error {}

/**
 * Extract an invoice as JSON. Even with a response schema, production code should
 * validate, tolerate stray markdown fences, and ask again once with the error.
 */
export async function extractInvoice(ai: GoogleGenAI, text: string, opts: { model?: string; maxAttempts?: number } = {}) {
  const { model = 'gemini-2.5-flash', maxAttempts = 2 } = opts;
  let prompt = `Extract the invoice from this text:\n\n${text}`;
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: 'application/json', responseJsonSchema: INVOICE_SCHEMA },
    });
    const finish = r.candidates?.[0]?.finishReason;
    if (finish === 'SAFETY') throw new ExtractionError('Response blocked by safety filters');
    if (finish === 'MAX_TOKENS') lastError = 'response was truncated';
    else {
      try {
        const value = parseLenient(r.text ?? '');
        const problems = validateInvoice(value);
        if (!problems.length) return { invoice: value as Invoice, attempts: attempt };
        lastError = problems.join('; ');
      } catch {
        lastError = 'response was not valid JSON';
      }
    }
    prompt = `${prompt}\n\nYour previous answer was invalid (${lastError}). Return only JSON matching the schema.`;
  }
  throw new ExtractionError(`Could not extract a valid invoice: ${lastError}`);
}

/** Parse JSON, tolerating a ```json fence and surrounding chatter. */
export function parseLenient(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1]! : text).trim());
}

export function validateInvoice(v: any): string[] {
  const problems: string[] = [];
  if (!v || typeof v !== 'object') return ['not an object'];
  for (const key of INVOICE_SCHEMA.required) if (!(key in v)) problems.push(`missing ${key}`);
  if ('vendor' in v && typeof v.vendor !== 'string') problems.push('vendor must be a string');
  if ('invoiceNumber' in v && typeof v.invoiceNumber !== 'string') problems.push('invoiceNumber must be a string');
  if ('total' in v && (typeof v.total !== 'number' || v.total < 0)) problems.push('total must be a non-negative number');
  if ('currency' in v && !INVOICE_SCHEMA.properties.currency.enum.includes(v.currency)) problems.push('currency is invalid');
  if ('lineItems' in v && (!Array.isArray(v.lineItems) || v.lineItems.length === 0)) problems.push('lineItems must be a non-empty array');
  return problems;
}
