# Setup: frameworks, env vars and options

[README](../README.md) · [Setup](setup.md) · [Scripting](scripting.md) · [Failures](failures.md) · [Assertions](assertions.md)

How to run mock-llm inside Vitest, Jest, Playwright or a child process, and every `createMockLLM` option.

## Vitest

`useMockLLM()` starts one mock per test file and resets rules and the journal after each test. Rules from the
`scenarioFiles` option are re-applied on every reset, so they're a baseline for every test. Importing the adapter
also registers the [matchers](assertions.md#asserting-on-what-your-app-sent):

```ts
import { useMockLLM } from 'mock-llm/vitest';
const mock = useMockLLM({ strict: true });

test('…', async () => {
  const openai = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test' }); // mock.urls is ready once the file's beforeAll has run
});
```

## Jest

`mock-llm/jest` has the same `useMockLLM()` and matchers as `mock-llm/vitest`. Import Jest's APIs from `@jest/globals`.
mock-llm is published as an ES module, so run Jest in ESM mode:

```jsonc
// package.json
"type": "module",
"scripts": { "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js" },
"jest": { "testEnvironment": "node", "transform": {}, "testMatch": ["**/test/**/*.test.mjs"] }
```

`testMatch` is only needed for `.mjs` test files on Jest 29: Jest 30's default pattern includes `.mjs`, Jest 29's doesn't.

Matcher types work both with `expect` from `@jest/globals` and with the global `expect` from `@types/jest`. For TypeScript
test files, keep your existing transform (ts-jest, babel or swc) configured for ESM. A CommonJS build, so Jest's default
setup works without the flag, is on the roadmap (R14). See [`examples/jest-travel-assistant`](../examples/jest-travel-assistant).

## Apps you don't construct directly (env vars)

`mock.env()` returns `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, plus dummy keys and credentials. With these set, `new OpenAI()`, `new Anthropic()`, `new GoogleGenAI({})` and `new BedrockRuntimeClient({})` all reach the mock with no code changes. Pass them to a child process to test a whole service, a CLI or **Claude Code** itself (see [`examples/claude-code-cli`](../examples/claude-code-cli)).

## Playwright

`mock-llm/playwright` runs **one shared mock for the whole run**. Your app server points at it through env vars, and
browser tests script and inspect it over HTTP through the `llm` fixture.

```js
// playwright.config.mjs
import { defineConfig } from '@playwright/test';
import { mockLLMEnv } from 'mock-llm/playwright';

export default defineConfig({
  workers: 1, // one shared mock: see "Parallel workers" below
  globalSetup: './tests/global-setup.mjs',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4321', env: { ...mockLLMEnv(4010), PORT: '4321' } },
  use: { baseURL: 'http://127.0.0.1:4321', llmStrict: true },
});

// tests/global-setup.mjs
import { startMockLLM } from 'mock-llm/playwright';
export default () => startMockLLM({ port: 4010, strict: true }); // returns the teardown
```

```js
// tests/chat.spec.mjs
import { test, expect } from 'mock-llm/playwright';

test('answers an order question', async ({ page, llm }) => {
  await llm.load({ rules: [{ when: { tool: 'lookup_order' }, toolCall: { name: 'lookup_order', input: { order_id: 'A-1' } } }] });
  await page.goto('/');
  // … drive the UI …
  await expect(llm).toHaveToolTrajectory(['lookup_order']); // matchers are async here
});
```

- **Scripting:** `llm.load({...})` takes the [scenario-file](scripting.md#scenario-files-yaml--json) format, because function
  responders can't cross processes. `llm` is reset before every test that uses it; rules from
  `startMockLLM({ scenarioFiles })` are re-applied, so they're a shared baseline.
- **Matchers:** all [matchers](assertions.md#asserting-on-what-your-app-sent) are available as `await expect(llm).…`. They fetch a
  journal snapshot first, which is why they're async.
- **`llmStrict: true`** (an option) fails a test that made an unscripted LLM request, even if the app showed a friendly
  error. Pair it with `startMockLLM({ strict: true })` so the app receives a real 400.
- **`blockRealProviders`** (an option, on by default) fails any test whose browser called a real provider API
  (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `bedrock-runtime.*.amazonaws.com`,
  `api.x.ai`). It guards *browser* traffic only. Your app server is pointed at the mock by `mockLLMEnv()`; hardcoded
  hosts on the server are roadmap R13.
- **`await llm.routeBrowser(page)`** sends browser-direct provider calls (e.g. "bring your own key" UIs) to the mock
  instead. Playwright buffers routed responses, so a stream arrives all at once.
- **Startup order:** Playwright starts `webServer` *before* `globalSetup`. That's fine when the app only calls the LLM
  while handling requests. If your app calls the LLM while booting, the mock isn't up yet; that isn't supported yet.
- **The control API works without Playwright too:** `new RemoteMockLLM(url)` (from `mock-llm`) has `load`, `reset`,
  `journal()` (a local, priced snapshot) and `assertNoUnmatched()`, and `remoteAssertions` has async versions of every
  matcher.

### Parallel workers

One mock is shared by the whole run, so tests in parallel workers would overwrite each other's rules and share a
journal. **Use `workers: 1` for suites that use the `llm` fixture** (the fixture warns if `workers > 1`). Per-test
isolation, so parallel workers can share one mock, is not supported yet (roadmap R15). See
[`examples/playwright-chat-ui`](../examples/playwright-chat-ui).

## Options

```ts
createMockLLM({
  port: 0,                 // ephemeral by default
  host: '127.0.0.1',       // localhost only by default
  seed: 1,                 // deterministic lorem, ids, chaos, latency; MOCK_LLM_SEED overrides it; see mock.seed
  latency: { firstTokenMs: 300, tokensPerSec: 50 },  // simulate slowness (off by default); firstTokenMs may be { min, max } or normal
  apiKeys: ['test-key'],   // enforce keys → native 401 otherwise
  models: ['gpt-4o', 'claude-sonnet-5-5'],           // models endpoints; or ModelSpec entries (see below)
  chaos: { rate: 0.05 },
  strict: true,            // unscripted requests get a 400 and fail the test (see Strict mode)
  onUnmatched: 'error',    // 400 for unscripted requests, without failing the test (default: canned reply)
  pricing: { 'gpt-4o': { input: 2.5, output: 10 } }, // USD per 1M tokens
  contextWindow: { 'gpt-4o': 128_000, '*': 8_000 },  // native context-length errors; tokens are APPROXIMATE
                                                     // (~4 chars/token, input only; see Context window)
  scenarioFiles: ['qa/scenarios.yaml'],              // loaded on start(), re-applied by every reset()
});
```

Token counts are approximate (~4 chars/token): good for budget assertions, not billing.

### Models, lifecycle and capabilities (Claude)

`models` takes ids or `ModelSpec` entries. Ids are active models with every capability. A spec describes a model the way
the Claude Models API (API version 2026-10-21) does:

```ts
import type { ModelSpec } from 'mock-llm';

createMockLLM({
  models: [
    'claude-opus-5-5',
    // Claude Sonnet 5.5 rejects thinking 'disabled' and offers 'between_tools' instead:
    { id: 'claude-sonnet-5-5', capabilities: { thinking: { types: { disabled: { supported: false } } } } },
    { id: 'claude-sonnet-4-5-20250929', lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00Z' },
    { id: 'claude-3-7-sonnet-20250219', lifecycle: 'retired' },
  ] satisfies Array<string | ModelSpec>,
});
```

- **`lifecycle`** (`'active'` by default): `models.list()` returns active and deprecated models unless its `lifecycle`
  filter asks for others, as the API does (SDK ≥ 1.0 sends the filter; older SDKs can't). `models.retrieve()` still finds
  a retired model. A Messages request naming a retired model fails: see
  [Model lifecycle and thinking errors](failures.md#model-lifecycle-and-thinking-errors-claude).
- **`deprecatedAt`, `retiresAt`** (RFC 3339): `deprecated_at` defaults to `2025-01-01T00:00:00Z` for deprecated and
  retired models (`null` when active); `retires_at` defaults to `null`.
- **`capabilities`**: a partial object merged over "everything supported", reported on model objects with every key
  present. `capabilities.thinking.types.<type>.supported: false` makes requests that send that thinking type fail.
- **`line`, `displayName`**: default to the line in a first-party Claude id (`claude-opus-5-5` → `opus`, else `null`)
  and to the id.
- Lifecycle and capabilities are Claude API concepts. The OpenAI and Gemini models endpoints list only the ids. Bedrock
  runs its own lifecycle, so it ignores `lifecycle`; capability rejections do apply to Claude bodies on Bedrock
  `InvokeModel` when the spec's `id` is the Bedrock model id.
