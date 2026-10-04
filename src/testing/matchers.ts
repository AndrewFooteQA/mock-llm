import {
  assertions,
  type AssertTarget,
  type EntryFilter,
  type RequestExpectation,
  type TextExpectation,
  type ToolStep,
} from '../assert/index.js';

/**
 * The assertion core wrapped in the `expect.extend` matcher shape shared by Vitest and Jest.
 * No test-framework imports here; each adapter registers these on its own `expect`.
 */
export const llmMatchers = Object.fromEntries(
  Object.entries(assertions).map(([name, fn]) => [
    name,
    function (received: unknown, ...args: unknown[]) {
      const r = (fn as (t: AssertTarget, ...a: unknown[]) => ReturnType<typeof assertions.toHaveOfferedTool>)(received as AssertTarget, ...args);
      return { pass: r.pass, message: r.message, expected: r.expected, actual: r.actual };
    },
  ]),
);

/** Matcher signatures, used to augment each framework's `expect` types. */
export interface MockLLMMatchers<R = unknown> {
  /** At least one chat request was received; with `expected`, one matches it partially. */
  toHaveReceivedRequest(expected?: RequestExpectation): R;
  /** Exactly `count` requests (chat by default) were received. */
  toHaveReceivedRequestTimes(count: number, filter?: EntryFilter): R;
  /** A system prompt or user message matches (substring, RegExp or asymmetric matcher). */
  toHaveReceivedPrompt(expected: TextExpectation, opts?: { in?: 'any' | 'system' | 'user' | 'lastUser'; filter?: EntryFilter }): R;
  /** A request offered this tool. */
  toHaveOfferedTool(name: string, filter?: EntryFilter): R;
  /** The mock asked the app to call this tool (args matched partially). */
  toHaveRequestedTool(name: string, args?: unknown, filter?: EntryFilter): R;
  /** The app sent back a result for this tool (string/RegExp on the raw content, object on parsed JSON). */
  toHaveReturnedToolResult(name: string, expected?: TextExpectation | Record<string, unknown> | unknown[], filter?: EntryFilter): R;
  /** Ordered tools the app ran (`source: 'returned'`) or the mock requested (`'requested'`). */
  toHaveToolTrajectory(
    expected: Array<string | ToolStep>,
    opts?: { mode?: 'exact' | 'subsequence'; source?: 'returned' | 'requested'; filter?: EntryFilter },
  ): R;
  /** Simulated tokens (total by default) are below `limit`. */
  toHaveUsedTokensLessThan(limit: number, opts?: { kind?: 'total' | 'input' | 'output'; filter?: EntryFilter }): R;
  /** Simulated USD cost is below `usd` (fails on unpriced models unless `allowUnpriced`). */
  toCostLessThan(usd: number, opts?: { filter?: EntryFilter; allowUnpriced?: boolean }): R;
  /** Every chat request matched a rule, scenario or default() (the strict-mode check). */
  toHaveNoUnmatchedRequests(filter?: EntryFilter): R;
  /** Every scenario expectation (`expectToolResult` / `expectRequest`) was met. */
  toHaveMetExpectations(filter?: EntryFilter): R;
}
