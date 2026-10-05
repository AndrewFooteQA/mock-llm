# mock-llm example projects

Each folder is a small, **standalone** project you can copy as a starting point. Each one has app code with nothing
mock-specific in it, plus a test suite that drives the app through mock-llm using the official provider SDK.

| Example | Provider / SDK | Test runner | Shows |
|---|---|---|---|
| [`openai-support-bot`](openai-support-bot) | OpenAI Chat · `openai` | Vitest | **Every fault**: `badRequest`, `authError` (and `apiKeys` → a real 401), `permissionDenied`, `notFound`, `requestTooLarge`, `raw` (a proxy's HTML 502), `rateLimit` (+ `times(2)`), `serverError` + `connectionReset` with SDK retries counted from the journal, `overloaded`, `timeout`, `contextLengthExceeded`. Output: refusals, empty, truncated, long, unicode, escaping + `inject`, `replyEcho`, scripted `usage`. **Context window**, **seeded chaos** (errors and content). **Strict mode** + the `unmatched` event, `onUnmatched: 'error'`, `UnmatchedRequestError`. A **shared YAML baseline** (`useMockLLM({ scenarioFiles, strict })`) across 8 tests: sequences and `once` rules start over, overrides don't leak. An **expectation step + strict mode** failing for the checked reason (`test/should-fail`, `posttest`). Matchers: `toHaveReceivedRequest`, `toHaveReceivedPrompt`, `toHaveUsedTokensLessThan`, `toHaveNoUnmatchedRequests` |
| [`claude-tool-agent`](claude-tool-agent) | Claude · `@anthropic-ai/sdk` | Vitest | Tool-use loops, parallel calls, hallucinated / malformed / wrong-type tool input, `replyToolCallFromSchema`, runaway loops. **`messages.stream()`** incl. a streamed tool turn; **`{ thinking }`** logged but never shown (adaptive thinking requested). Rules: model glob, `tools`, `system`, `turn`, `hasTools`, `stream`, `anyMessage`, `where`. Matchers: `toHaveToolTrajectory`, `toHaveRequestedTool`, `toHaveReturnedToolResult`, `toHaveOfferedTool`, `toHaveReceivedRequestTimes`. Typed `JournalEntry` / `ReplyOptions` |
| [`gemini-structured-extraction`](gemini-structured-extraction) | Gemini · `@google/genai` | Vitest | JSON-schema output, `replyFromSchema` (+`violate`), fenced / almost JSON, repair-and-retry, safety blocks. **`generateContentStream`** with progress and a **mid-stream 503** the app reports. The same extraction through a **Vertex AI** client (OAuth). `fakeFromSchema` fixtures for the validator. Matchers: `toHaveReceivedRequest` (schema sent, Vertex auth header), `toHaveReceivedPrompt` (retry prompt) |
| [`bedrock-streaming-summarizer`](bedrock-streaming-summarizer) | Bedrock · `@aws-sdk/client-bedrock-runtime` | Vitest | **ConverseStream** over the binary event stream, **Converse**, **InvokeModel** and **InvokeModelWithResponseStream** with a Claude body (`max_tokens` → truncated). Mid-stream cuts, in-stream throttling, latency (global, per-rule seeded random, per-step `delay`, asserted via `entry.latency`). **Events**: `request`, `chunk` (decoded frames), `response`, `fault`. The journal's `wire` record. Matcher: `toHaveReceivedRequest` |
| [`node-service-e2e`](node-service-e2e) | OpenAI **and** Claude | `node:test` (plain JS) | A real service run as a child process via `mock.env()`, with an LLM timeout. A YAML QA scenario file: expectation steps, routing on a forwarded header, `echo` / `lorem` / `json` scenarios. **`x-mock-scenario`** forwarded by the service (`LLM_FORWARD_HEADERS`), and a **sweep of every built-in scenario**. `[[mock:…]]` tokens. Assertions as **plain functions** (`toHaveReceivedRequest(mock, …)`, `toHaveMetExpectations`), `ExpectationError` |
| [`jest-travel-assistant`](jest-travel-assistant) | OpenAI Responses API · `openai` | **Jest** (ESM, plain JS) | `mock-llm/jest` with **strict mode**; Responses API tool loop via `previous_response_id`, **`responses.stream()`** checked against `finalResponse()`, conversation memory, refusals, 429 retries. Matchers: `toHaveToolTrajectory`, `toHaveRequestedTool`, `toHaveReturnedToolResult`, `toHaveReceivedRequest(Times)`, `toHaveReceivedPrompt`, `toHaveNoUnmatchedRequests` |
| [`playwright-chat-ui`](playwright-chat-ui) | OpenAI Chat · `openai` (server **and** browser-direct) | **Playwright** (Chromium) | `mock-llm/playwright`: shared mock via `globalSetup` + `mockLLMEnv`, `llm.load` scripting (incl. an **expectation step**), `llm.routeBrowser(page)`, **real-provider guard**, **strict mode** (`llmStrict`), tool loop / outage / streaming (incl. **mid-stream UI state via exact chunks**) / prompt-injection in the real UI. Async matchers: `toHaveToolTrajectory`, `toHaveReturnedToolResult`, `toHaveReceivedRequest(Times)`, `toHaveNoUnmatchedRequests` |
| [`rag-knowledge-base`](rag-knowledge-base) | OpenAI, Claude, Gemini, Bedrock | Vitest | **Embeddings** through every SDK: OpenAI (base64 default and `float`), Gemini AI Studio (batch) and **Vertex AI** (`:predict`), Bedrock Titan (InvokeModel). **Token counting** before sending (Anthropic, Gemini, Bedrock CountTokens) to fit a budget. **`models.list`** with the `models` option. **Strict mode**; `toHaveReceivedPrompt` (top passage reached the prompt), **`toCostLessThan`** + `journal.cost()` with custom `pricing` |
| [`claude-code-cli`](claude-code-cli) | Claude Code CLI | Node script | Running the actual `claude` CLI against the mock and asserting on what it sent (`toHaveReceivedPrompt`, `toHaveReceivedRequest` as plain functions). Exits 77 (skipped) without the CLI; CI installs it |

## Running

```sh
cd examples/<name>
npm install
npm test
```

From the repo root, `npm run test:examples` builds mock-llm, installs a fresh copy into every example, and runs them all.
Pass a name filter to run some of them: `npm run test:examples -- gemini`. Results are ✔ passed, ✘ failed or ⊘ skipped
(an example exits 77 when it can't run here, e.g. without the `claude` CLI). A skip fails the run when `CI=true`.

The TypeScript examples type-check (`tsc --noEmit`, `strict`) before their tests, against the packed package's `.d.ts`,
the way a user's project would.

`npm run coverage:examples` lists which library features the examples use: every export, fault, edge case, built-in
scenario, matcher, rule method, option, matcher key, scenario-file step, event and provider SDK call. Features with no
example must be exempted with a reason in [`coverage.json`](coverage.json). `--by-example` lists each example's features
(use it to keep the tables above accurate), and `--json` gives the full report.

> These examples depend on the repo copy of mock-llm (`"mock-llm": "file:../.."`, installed as a packed copy via
> `install-links=true` in `.npmrc`). In your own project, use `npm install -D mock-llm`.
