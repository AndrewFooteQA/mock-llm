import { afterAll, afterEach, beforeAll, expect } from '@jest/globals';
import { MockLLM, type MockLLMOptions } from '../mock.js';
import { llmMatchers, runAfterTestChecks, type MockLLMMatchers } from './matchers.js';

/**
 * Jest adapter: start one mock per test file, reset rules + journal after each test, stop at the end.
 * With `{ strict: true }`, a test fails if the app made an LLM request no rule scripted.
 *
 *   import { useMockLLM } from 'mock-llm/jest';
 *   const mock = useMockLLM({ strict: true });
 *
 * mock-llm is ESM-only: run Jest with `NODE_OPTIONS=--experimental-vm-modules` (see README).
 */
export function useMockLLM(options: MockLLMOptions = {}): MockLLM {
  const mock = new MockLLM(options);
  beforeAll(() => mock.start());
  afterEach(async () => {
    // Scenario expectations always fail the test when unmet; in strict mode an unscripted request does too,
    // even if the app swallowed the error. Both are reported when both fail.
    try {
      await runAfterTestChecks([() => mock.assertExpectations(), ...(options.strict ? [() => mock.assertNoUnmatched()] : [])]);
    } finally {
      mock.reset();
    }
  });
  afterAll(() => mock.stop());
  return mock;
}

/**
 * Matchers over what the app sent, registered when this module is imported. Same names and
 * semantics as `mock-llm/vitest`; they avoid Jest's built-in `toHaveBeenCalled*` on purpose.
 */
expect.extend(llmMatchers);

export { llmMatchers, type MockLLMMatchers };

// Types for `expect` from '@jest/globals'…
declare module 'expect' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<R extends void | Promise<void>, T = unknown> extends MockLLMMatchers<R> {}
}

// …and for the global `expect` typed by @types/jest.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Matchers<R, T = {}> extends MockLLMMatchers<R> {}
  }
}
