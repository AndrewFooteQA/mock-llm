import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { MockLLM, type MockLLMOptions } from '../mock.js';
import { llmMatchers, runAfterTestChecks, type MockLLMMatchers } from './matchers.js';

/**
 * Start one mock per test file, reset rules + journal after each test, stop at the end.
 * With `{ strict: true }`, a test fails if the app made an LLM request no rule scripted.
 *
 *   const mock = useMockLLM();
 *   it('...', async () => { mock.when('hi').reply('hello'); ... });
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
 * Vitest matchers over what the app sent, registered when this module is imported:
 *
 *   expect(mock).toHaveOfferedTool('lookup_order');
 *   expect(mock).toHaveToolTrajectory(['search', 'get_product']);
 *
 * Names avoid Vitest's built-in spy matchers (`toHaveBeenCalled*`) on purpose.
 */
expect.extend(llmMatchers);

export { llmMatchers, type MockLLMMatchers };

// Vitest 5: \`expect(x)\` returns Assertion<R, T>, which extends vitest's Matchers<R, T>.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<R, T> extends MockLLMMatchers<R> {}
}
// Vitest 4: its Matchers<T> has one type parameter (so the declaration above can't merge with it), but Assertion<T>
// extends the global jest.Matchers<void, T>. Augmenting that gives Vitest 4 users the matcher types too.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Matchers<R, T = {}> extends MockLLMMatchers<R> {}
  }
}
