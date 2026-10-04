# mock-llm example projects

Each folder is a small, **standalone** project you can copy as a starting point. Each one has app code with nothing
mock-specific in it, plus a test suite that drives the app through mock-llm using the official provider SDK.

| Example | Provider / SDK | Test runner | Shows |
|---|---|---|---|
| [`openai-support-bot`](openai-support-bot) | OpenAI Chat · `openai` | Vitest | Refusals, truncation, output escaping, 429 retries, outages, timeouts, **context window** (`contextWindow` → "please shorten"), **seeded chaos**, errors and content (`weights`, `entry.chaos`, `MOCK_LLM_SEED`). **Strict mode** catching a call the bot hides. Matchers: `toHaveReceivedRequest`, `toHaveReceivedPrompt`, `toHaveUsedTokensLessThan`, `toHaveNoUnmatchedRequests` |
| [`claude-tool-agent`](claude-tool-agent) | Claude · `@anthropic-ai/sdk` | Vitest | Tool-use loops, parallel calls, hallucinated tools, bad args, runaway loops. Rules: model glob + `tools` matcher. Matchers: `toHaveToolTrajectory`, `toHaveRequestedTool`, `toHaveReturnedToolResult`, `toHaveReceivedRequestTimes` |
| [`gemini-structured-extraction`](gemini-structured-extraction) | Gemini · `@google/genai` | Vitest | JSON-schema output, `replyFromSchema` (+`violate`), fenced/almost JSON, repair-and-retry, safety blocks. Matchers: `toHaveReceivedRequest` (schema sent), `toHaveReceivedPrompt` (retry prompt) |
| [`bedrock-streaming-summarizer`](bedrock-streaming-summarizer) | Bedrock · `@aws-sdk/client-bedrock-runtime` | Vitest | ConverseStream over the binary event stream, mid-stream cuts, in-stream throttling, latency (global + **per-rule seeded random**, asserted via `entry.latency`). **Events**: `mock.on('chunk')` with decoded frames. Matcher: `toHaveReceivedRequest` |
| [`node-service-e2e`](node-service-e2e) | OpenAI **and** Claude | `node:test` (plain JS) | A real service run as a child process via `mock.env()`, a YAML QA scenario file, `[[mock:…]]` tokens, **expectation steps** in the YAML (`mock.assertExpectations()`). Assertions as **plain functions** (`toHaveReceivedRequest(mock, …)`) outside Vitest |
| [`jest-travel-assistant`](jest-travel-assistant) | OpenAI Responses API · `openai` | **Jest** (ESM, plain JS) | `mock-llm/jest` with **strict mode**; Responses API tool loop via `previous_response_id`, conversation memory, refusals, 429 retries. Matchers: `toHaveToolTrajectory`, `toHaveRequestedTool`, `toHaveReturnedToolResult`, `toHaveReceivedRequest(Times)`, `toHaveReceivedPrompt`, `toHaveNoUnmatchedRequests` |
| [`playwright-chat-ui`](playwright-chat-ui) | OpenAI Chat · `openai` (server **and** browser-direct) | **Playwright** (Chromium) | `mock-llm/playwright`: shared mock via `globalSetup` + `mockLLMEnv`, `llm.load` scripting (incl. an **expectation step**), `llm.routeBrowser(page)`, **real-provider guard**, **strict mode** (`llmStrict`), tool loop / outage / streaming (incl. **mid-stream UI state via exact chunks**) / prompt-injection in the real UI. Async matchers: `toHaveToolTrajectory`, `toHaveReturnedToolResult`, `toHaveReceivedRequest(Times)`, `toHaveNoUnmatchedRequests` |
| [`claude-code-cli`](claude-code-cli) | Claude Code CLI | Node script | Running the actual `claude` CLI against the mock |

## Running

```sh
cd examples/<name>
npm install
npm test
```

From the repo root, `npm run test:examples` builds mock-llm, installs a fresh copy into every example, and runs them all.
Pass a name filter to run some of them: `npm run test:examples -- gemini`.

> These examples depend on the repo copy of mock-llm (`"mock-llm": "file:../.."`, installed as a packed copy via
> `install-links=true` in `.npmrc`). In your own project, use `npm install -D mock-llm`.
