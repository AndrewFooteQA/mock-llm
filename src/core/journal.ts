import { priceFor, type PriceTable } from './pricing.js';
import type { Endpoint, Fault, IRRequest, IRResponse, IRUsage, Provider } from './types.js';

export interface JournalEntry {
  id: number;
  provider: Provider;
  endpoint: Endpoint;
  method: string;
  path: string;
  request: IRRequest;
  /** The response that was rendered (absent when a fault replaced it). */
  response?: IRResponse;
  fault?: Fault;
  status: number;
  usage?: IRUsage;
  /** Name of the rule / scenario that answered, if any. */
  matchedBy?: string;
  /** A chat request no rule, scenario or default() was scripted for (see `strict`). */
  unmatched?: boolean;
  /** Results of the scenario expectations on the step that answered (`expectToolResult` / `expectRequest`). */
  expectations?: Array<{ location: string; kind: 'expectToolResult' | 'expectRequest'; pass: boolean; message: string }>;
  /** Set when chaos changed this exchange: which `behaviour`, and the `seed` that reproduces it (`MOCK_LLM_SEED`). */
  chaos?: { seed: number; behaviour: 'error' | 'refusal' | 'empty' | 'truncated' | 'malformedToolCall' };
  /** Latency applied to the response (sampled delays are recorded, so tests can assert them). */
  latency?: { firstTokenMs: number; tokensPerSec: number; chunkIntervalMs?: number };
  startedAt: number;
  durationMs?: number;
  /** The raw HTTP exchange (when `recordWire` is on). Binary event-stream frames are decoded to text. */
  wire?: WireRecord;
}

export interface WireRecord {
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  response: { status?: number; headers?: Record<string, string>; body: string; truncated?: boolean; aborted?: string };
}

export interface JournalFilter {
  provider?: Provider;
  endpoint?: Endpoint;
  model?: string;
}

export interface CostReport {
  /** Simulated USD for priced models. */
  total: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; usd: number | null }>;
  /** Models with usage but no price in the table. */
  unpriced: string[];
}

/** Records every exchange so tests can assert on what the app actually sent. */
export class Journal {
  private entries: JournalEntry[] = [];

  constructor(
    private pricing: PriceTable = {},
    /** The mock's effective seed (for reproduction hints in failure messages). */
    readonly seed?: number,
  ) {}

  add(entry: JournalEntry): void {
    this.entries.push(entry);
  }

  all(filter?: JournalFilter | ((entry: JournalEntry) => boolean)): JournalEntry[] {
    if (!filter) return [...this.entries];
    if (typeof filter === 'function') return this.entries.filter(filter);
    return this.entries.filter(
      (e) =>
        (!filter.provider || e.provider === filter.provider) &&
        (!filter.endpoint || e.endpoint === filter.endpoint) &&
        (!filter.model || e.request.model === filter.model),
    );
  }

  last(filter?: JournalFilter): JournalEntry | undefined {
    return this.all(filter).at(-1);
  }

  count(filter?: JournalFilter): number {
    return this.all(filter).length;
  }

  /** Total simulated token usage, optionally filtered. */
  usage(filter?: JournalFilter): IRUsage {
    const total: IRUsage = { inputTokens: 0, outputTokens: 0 };
    for (const e of this.all(filter)) {
      total.inputTokens += e.usage?.inputTokens ?? 0;
      total.outputTokens += e.usage?.outputTokens ?? 0;
    }
    return total;
  }

  /** Simulated spend from recorded usage and the price table. */
  cost(filter?: JournalFilter | ((entry: JournalEntry) => boolean)): CostReport {
    const report: CostReport = { total: 0, byModel: {}, unpriced: [] };
    for (const e of this.all(filter)) {
      if (!e.usage) continue;
      const m = (report.byModel[e.request.model] ??= { inputTokens: 0, outputTokens: 0, usd: 0 });
      m.inputTokens += e.usage.inputTokens;
      m.outputTokens += e.usage.outputTokens;
    }
    for (const [model, m] of Object.entries(report.byModel)) {
      const price = priceFor(model, this.pricing);
      if (!price) {
        m.usd = null;
        report.unpriced.push(model);
        continue;
      }
      m.usd = (m.inputTokens * price.input + m.outputTokens * price.output) / 1e6;
      report.total += m.usd;
    }
    return report;
  }

  clear(): void {
    this.entries = [];
  }
}
