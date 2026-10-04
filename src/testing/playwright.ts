import { test as base, expect as baseExpect, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { AssertionResult } from '../assert/index.js';
import { assertions } from '../assert/index.js';
import { createMockLLM, envFor, type MockLLMOptions } from '../mock.js';
import { RemoteMockLLM, remoteAssertions } from '../remote.js';

/**
 * Playwright integration. The mock runs once for the whole run (started in globalSetup),
 * the app under test gets `mockLLMEnv(port)` via `webServer.env`, and tests control the
 * mock over HTTP through the `llm` fixture.
 *
 *   // playwright.config.ts
 *   webServer: { command: 'node server.js', env: mockLLMEnv(4010) },
 *   globalSetup: './global-setup.ts',            // export default () => startMockLLM({ port: 4010 })
 *
 *   // a test
 *   import { test, expect } from 'mock-llm/playwright';
 *   test('…', async ({ page, llm }) => { await llm.load({ rules: [...] }); … await expect(llm).toHaveOfferedTool('x'); });
 *
 * Note: Playwright starts `webServer` *before* globalSetup. That's fine as long as the app
 * only calls the LLM while handling requests (tests run after globalSetup).
 */

/** Env var the fixture reads to find the mock (set by `startMockLLM`). */
export const MOCK_LLM_URL_ENV = 'MOCK_LLM_URL';

/** SDK env vars for an app talking to a mock on `port` (for `webServer.env`). Pure: no mock needed yet. */
export function mockLLMEnv(port: number, apiKey?: string): Record<string, string> {
  return envFor(`http://127.0.0.1:${port}`, apiKey);
}

/**
 * Start the shared mock for a Playwright run. Use as (or in) `globalSetup`; returns the teardown.
 * Sets `MOCK_LLM_URL` so test workers can reach it.
 */
export async function startMockLLM(options: MockLLMOptions & { port: number }): Promise<() => Promise<void>> {
  const mock = await createMockLLM({ ...options, host: options.host ?? '127.0.0.1' });
  process.env[MOCK_LLM_URL_ENV] = mock.urls.base;
  return () => mock.stop();
}

/** Real provider API hosts the browser might call directly, and where they live on the mock. */
const PROVIDER_ROUTES: Array<{ host: RegExp; prefix: string }> = [
  { host: /^api\.openai\.com$/, prefix: '/openai' },
  { host: /^api\.x\.ai$/, prefix: '/openai' },
  { host: /^api\.anthropic\.com$/, prefix: '/anthropic' },
  { host: /^generativelanguage\.googleapis\.com$/, prefix: '/gemini' },
  { host: /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/, prefix: '/bedrock' },
];

/** The mock URL a real provider URL maps to, or null if it isn't a known provider API. */
export function providerRewrite(url: string, mockBaseUrl: string): string | null {
  const u = new URL(url);
  const route = PROVIDER_ROUTES.find((r) => r.host.test(u.hostname));
  return route ? `${mockBaseUrl.replace(/\/+$/, '')}${route.prefix}${u.pathname}${u.search}` : null;
}

const isProviderUrl = (url: URL) => PROVIDER_ROUTES.some((r) => r.host.test(url.hostname));

function corsHeaders(route: Route): Record<string, string> {
  const req = route.request().headers();
  return {
    'access-control-allow-origin': req['origin'] ?? '*',
    'access-control-allow-headers': req['access-control-request-headers'] ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

/** Mock client with Playwright extras. */
export class PlaywrightMockLLM extends RemoteMockLLM {
  /**
   * Send browser-originated provider calls (e.g. a "bring your own key" UI calling
   * api.openai.com directly) to the mock instead. Responses are buffered by Playwright,
   * so streams arrive at once rather than chunk by chunk.
   */
  async routeBrowser(target: Page | BrowserContext): Promise<void> {
    await target.route(isProviderUrl, async (route) => {
      const cors = corsHeaders(route);
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const response = await route.fetch({ url: providerRewrite(route.request().url(), this.baseUrl)! });
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
  }
}

type MatcherResult = { pass: boolean; message: () => string; name: string; expected?: unknown; actual?: unknown };
type Tail<T> = T extends [unknown, ...infer R] ? R : never;
type AsyncMatchers = {
  [K in keyof typeof assertions]: (this: unknown, received: unknown, ...args: Tail<Parameters<(typeof assertions)[K]>>) => Promise<MatcherResult>;
};

/** The R2 matchers as async Playwright matchers: `await expect(llm).toHaveToolTrajectory([...])`. */
const matchers = Object.fromEntries(
  Object.entries(remoteAssertions).map(([name, fn]) => [
    name,
    async function (received: unknown, ...args: unknown[]): Promise<MatcherResult> {
      const r: AssertionResult = await (fn as (t: unknown, ...a: unknown[]) => Promise<AssertionResult>)(received, ...args);
      return { pass: r.pass, message: r.message, name, expected: r.expected, actual: r.actual };
    },
  ]),
) as AsyncMatchers;

export const expect = baseExpect.extend(matchers);

export interface MockLLMFixtures {
  /** Control client for the shared mock; reset before each test that uses it. */
  llm: PlaywrightMockLLM;
  /** Option: after each test using `llm`, fail if any LLM request matched no rule (default false). */
  llmStrict: boolean;
  /** Option: fail the test if the browser calls a real provider API un-routed (default true). */
  blockRealProviders: boolean;
}

let warnedWorkers = false;

export const test = base.extend<MockLLMFixtures & { _realProviderGuard: void }>({
  llmStrict: [false, { option: true }],
  blockRealProviders: [true, { option: true }],

  llm: async ({ llmStrict }, use, testInfo) => {
    const url = process.env[MOCK_LLM_URL_ENV];
    if (!url) {
      throw new Error(
        `mock-llm: ${MOCK_LLM_URL_ENV} is not set. Start the mock in globalSetup: export default () => startMockLLM({ port: 4010 }) (from 'mock-llm/playwright').`,
      );
    }
    if (testInfo.config.workers > 1 && !warnedWorkers) {
      warnedWorkers = true;
      console.warn(
        `[mock-llm] ${testInfo.config.workers} workers share one mock: tests' rules and journals will interfere. Use workers: 1 for suites that use the llm fixture (see README › Playwright).`,
      );
    }
    const llm = new PlaywrightMockLLM(url);
    await llm.reset();
    await use(llm);
    await llm.assertExpectations(); // scenario expectations always fail the test when unmet
    if (llmStrict) await llm.assertNoUnmatched();
  },

  // Always on (unless blockRealProviders: false): real provider calls from the browser fail the test.
  _realProviderGuard: [
    async ({ context, blockRealProviders }, use) => {
      const blocked: string[] = [];
      if (blockRealProviders) {
        await context.route(isProviderUrl, (route) => {
          blocked.push(`${route.request().method()} ${route.request().url()}`);
          return route.abort('blockedbyclient');
        });
      }
      await use();
      if (blocked.length) {
        throw new Error(
          `REAL LLM PROVIDER REQUEST BLOCKED: the browser tried to call a real provider API:\n  ${blocked.join('\n  ')}\n` +
            `Route it to the mock with \`await llm.routeBrowser(page)\`, or set blockRealProviders: false to allow it.`,
        );
      }
    },
    { auto: true },
  ],
});
