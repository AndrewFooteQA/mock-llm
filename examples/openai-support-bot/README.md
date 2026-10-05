# Example: OpenAI support bot (Vitest)

A customer-support bot built on the official `openai` SDK, tested with mock-llm. It shows how to:

- point the SDK at the mock (`baseURL: mock.urls.openai`)
- script replies with matchers
- test **refusals**, **truncation**, **prompt-injection output**, **429 retries**, **outages** and **timeouts**
- run under **seeded chaos**, both errors and **content chaos** (refusals, empty and truncated answers), and put `mock.seed` in assertion messages so a failure can be replayed with `MOCK_LLM_SEED`
- simulate the model's **context window** (`contextWindow`) and handle `context_length_exceeded` with a "please shorten" reply
- run in **strict mode** (`useMockLLM({ strict: true })`), so an LLM call no test scripted fails the test even though the bot hides API errors from users
- assert on what the app *sent* with mock-llm's matchers (`toHaveReceivedRequest`, `toHaveReceivedPrompt`, `toHaveUsedTokensLessThan`)
- handle **every fault**: a dropped connection and a 500 retried by the SDK (counted from the journal), a wrong API key
  (`apiKeys` → a real 401, shown as a configuration problem), and 400 / 403 / 404 / 413 and a proxy's HTML 502 (`faults.raw`)
- handle **awkward output**: empty, very long and unicode answers, injected markup (`inject`), and scripted `usage`
- share a **YAML baseline** across a test file (`test/baseline.test.ts`, `useMockLLM({ scenarioFiles, strict: true })`).
  Every test starts from a fresh copy: sequences and `once` rules start over, and one test's overrides don't leak into the next
- prove the safety nets: `test/should-fail/` holds a test that *must* fail (an unmet expectation step plus an unscripted
  request, with the bot hiding both). `npm test`'s `posttest` runs it and checks it failed for exactly those reasons

```sh
npm install
npm test        # tsc --noEmit (strict, against mock-llm's published types), then vitest
```

| File | What it is |
|---|---|
| `src/bot.ts` | The app code. It contains nothing mock-specific. |
| `test/bot.test.ts` | Tests using `useMockLLM()` from `mock-llm/vitest` |
| `test/baseline.test.ts` + `test/scenarios/support-baseline.yaml` | Tests sharing a YAML baseline that every test gets a fresh copy of |
| `test/should-fail/strict-expectation.ts` | A test that must fail (run only by the `posttest` check, never by `vitest run`) |
| `test/check-expected-failures.mjs` + `vitest.should-fail.config.ts` | Runs it and checks it failed for the expected reasons |
| `tsconfig.json` | Strict type-check of the app and tests, as a user's project would |

> This example installs mock-llm from the repo (`file:../..`). In your own project, use `npm install -D mock-llm`.
