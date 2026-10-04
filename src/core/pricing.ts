/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
}

export type PriceTable = Record<string, Price>;

/**
 * Built-in prices: Anthropic first-party list prices (as of 2026-09-25).
 * Other providers' prices change often and differ by tier/region, so they are
 * not bundled. Pass your own via `createMockLLM({ pricing })`, keyed by model id
 * or id prefix. Bedrock/Vertex model ids (`us.anthropic.claude-…`) match the
 * Claude entries but partner pricing can differ; override if it matters.
 */
export const DEFAULT_PRICING: PriceTable = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Find the price for a model: exact id, then longest table key contained in the id. */
export function priceFor(model: string, table: PriceTable): Price | undefined {
  if (table[model]) return table[model];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.includes(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}
