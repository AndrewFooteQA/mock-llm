# Example: Playwright full-stack chat UI

A tiny chat app whose **server** calls OpenAI, plus a "bring your own key" button that calls `api.openai.com` directly
from the **browser**. It's tested end to end in Chromium with `mock-llm/playwright`. It shows how to:

- start one shared mock in `globalSetup` (`startMockLLM`) and point the app at it with `webServer.env: mockLLMEnv(port)`
- script the mock per test from the browser test (`llm.load({...})`, the scenario-file format) and assert with async matchers
  (`await expect(llm).toHaveToolTrajectory(...)`, `toHaveReturnedToolResult`, `toHaveReceivedRequest(Times)`, `toHaveNoUnmatchedRequests`)
- test a tool loop (with an **expectation step**: `expectToolResult`, checked automatically by the fixture), an outage, a streamed answer and prompt-injection output in the real UI
- assert the UI's **intermediate** streaming state using exact chunks (`reply: { chunks: [...] }` + `chunkIntervalMs`)
- route browser-direct provider calls to the mock with `llm.routeBrowser(page)`
- rely on two safety nets, each proven by a deliberately failing test (`test.fail`):
  - **blockRealProviders** (on by default): an un-routed browser call to a real provider API fails the test
  - **strict mode** (`startMockLLM({ strict: true })` + `use: { llmStrict: true }`): an unscripted LLM call fails the test, even though the app shows a friendly error
  - `posttest` checks the JSON report so those tests fail for exactly the intended reason, not a timeout

```sh
npm install
npx playwright install chromium   # once
npm test
```

| File | What it is |
|---|---|
| `server.mjs`, `public/index.html` | The app. It contains nothing mock-specific (configured by env vars). |
| `playwright.config.mjs` | `webServer.env: mockLLMEnv(4010)`, `globalSetup`, `workers: 1`, `llmStrict: true` |
| `tests/global-setup.mjs` | `startMockLLM({ port: 4010, strict: true })` |
| `tests/chat.spec.mjs` | The browser tests |
| `tests/check-expected-failures.mjs` | Verifies the deliberate failures fail for the right reason |

**Why `workers: 1`?** One mock serves the whole run, so tests running in parallel would overwrite each other's rules
and share a journal. See the root README › Playwright › Parallel workers.
