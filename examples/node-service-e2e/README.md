# Example: end-to-end service test (node:test, plain JS)

A small HTTP service that calls OpenAI **or** Claude. It is tested end to end by running it as a **child process**
pointed at mock-llm purely through environment variables. There is no build step and no test framework, only Node's built-in `node:test`.

It shows how to:

- use `mock.env()` (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, dummy keys) to redirect an unmodified app
- keep QA behaviour in a **YAML scenario file** (`qa/scenarios.yaml`) that non-developers can edit, including **expectation steps** (`expectRequest`) checked with `mock.assertExpectations()`
- trigger failures with **no code changes**, using a `[[mock:rate-limit]]` token in user input, or an `x-mock-scenario`
  header the service forwards to its LLM call (`LLM_FORWARD_HEADERS`, the same mechanism as tracing headers)
- sweep **every built-in scenario** through the running service: each must give a reply or a clean 503, never a crash
  (this found that the service needed an LLM timeout: `LLM_TIMEOUT_MS`)
- route on a forwarded header in the QA file, and use `echo`, `lorem` and `json` scenarios there
- run the same suite against **two providers**
- assert on what the service sent with mock-llm's framework-agnostic assertion functions (`toHaveReceivedRequest(mock, …)`
  and `toHaveMetExpectations(mock)` return `{ pass, message }`; `mock.assertExpectations()` throws an `ExpectationError`),
  or via `mock.journal` / `GET /__mock/journal`

```sh
npm install
npm test
```

| File | What it is |
|---|---|
| `src/server.mjs` | The service. It contains nothing mock-specific and is configured by env vars. |
| `qa/scenarios.yaml` | Scripted LLM behaviour for QA |
| `test/e2e.test.mjs` | End-to-end tests |
