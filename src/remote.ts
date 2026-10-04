import { assertions, toHaveMetExpectations, toHaveNoUnmatchedRequests, type AssertionResult, type AssertTarget } from './assert/index.js';
import { Journal, type JournalEntry } from './core/journal.js';
import type { PriceTable } from './core/pricing.js';
import type { ScenarioFile } from './core/scenario-file.js';
import { envFor, ExpectationError, UnmatchedRequestError, urlsFor, type MockUrls } from './mock.js';

/**
 * Control a mock-llm running in another process (e.g. started in Playwright's globalSetup)
 * over its HTTP control API. Scripting uses the scenario-file format, since function
 * responders can't cross processes.
 */
export class RemoteMockLLM {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get urls(): MockUrls {
    return urlsFor(this.baseUrl);
  }

  /** Env vars pointing SDKs at this mock (same as `mock.env()`). */
  env(apiKey?: string): Record<string, string> {
    return envFor(this.baseUrl, apiKey);
  }

  async info(): Promise<{ urls: MockUrls; strict: boolean; pricing: PriceTable; seed: number }> {
    return this.call('GET', '/__mock/info');
  }

  /** Clear rules, scenarios and the journal. */
  async reset(): Promise<void> {
    await this.call('POST', '/__mock/reset');
  }

  /** Add rules/scenarios/default from a scenario-file object (the YAML/JSON format). */
  async load(scenario: ScenarioFile): Promise<void> {
    await this.call('POST', '/__mock/load', scenario);
  }

  /** A local snapshot of the remote journal, priced like the remote mock (usable with all assertions). */
  async journal(): Promise<Journal> {
    const [entries, info] = await Promise.all([this.call<JournalEntry[]>('GET', '/__mock/journal'), this.info()]);
    const journal = new Journal(info.pricing, info.seed);
    for (const e of entries) journal.add(e);
    return journal;
  }

  /** Throws `ExpectationError` if any scenario expectation failed (names scenario, rule and step). */
  async assertExpectations(): Promise<void> {
    const r = toHaveMetExpectations(await this.journal());
    if (!r.pass) throw new ExpectationError(r.message());
  }

  /** Throws `UnmatchedRequestError` if any chat request matched no rule (see strict mode). */
  async assertNoUnmatched(): Promise<void> {
    const r = toHaveNoUnmatchedRequests(await this.journal());
    if (!r.pass) throw new UnmatchedRequestError(r.message());
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`mock-llm: cannot reach the mock at ${this.baseUrl} (${(err as Error).message}). Is it running?`);
    }
    const json = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`mock-llm control ${method} ${path} failed (${res.status}): ${json?.error?.message ?? 'unknown error'}`);
    return json;
  }
}

/** Resolve a matcher target: remote mocks are snapshotted first; local targets pass through. */
export async function resolveTarget(target: unknown): Promise<AssertTarget> {
  return target instanceof RemoteMockLLM ? await target.journal() : (target as AssertTarget);
}

/**
 * Async versions of every assertion, accepting a `RemoteMockLLM` (or any local target).
 * Used by `mock-llm/playwright`; handy for any async/out-of-process test setup.
 */
export const remoteAssertions = Object.fromEntries(
  Object.entries(assertions).map(([name, fn]) => [
    name,
    async (target: unknown, ...args: unknown[]): Promise<AssertionResult> =>
      (fn as (t: AssertTarget, ...a: unknown[]) => AssertionResult)(await resolveTarget(target), ...args),
  ]),
) as { [K in keyof typeof assertions]: (target: unknown, ...args: Parameters<(typeof assertions)[K]> extends [unknown, ...infer A] ? A : never) => Promise<AssertionResult> };
