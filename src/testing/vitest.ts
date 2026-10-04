import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { MockLLM, type MockLLMOptions } from '../mock.js';
import { llmMatchers, type MockLLMMatchers } from './matchers.js';

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
  afterEach(() => {
    // In strict mode an unscripted request fails the test, even if the app swallowed the error.
    try {
      mock.assertExpectations(); // scenario expectations always fail the test when unmet
      if (options.strict) mock.assertNoUnmatched();
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

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<R, T> extends MockLLMMatchers<R> {}
}
