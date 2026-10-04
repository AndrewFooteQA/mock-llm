---
"mock-llm": patch
---

Bug fixes:

- `scenarioFiles` rules now survive `reset()`. Previously only the first test in a `useMockLLM({ scenarioFiles })` file (or the first Playwright test with `startMockLLM({ scenarioFiles })`) saw them, because the per-test reset cleared them. They are now re-applied fresh on every reset; rules added with `load()` or `when()` are still cleared.
- RegExp matchers with the `g` or `y` flag (including `"/…/gi"` in scenario files) matched only every other request. The same applied to assertions. Every test now starts at the beginning of the string.
- A request body the mock can't read (e.g. `messages: [null]`) now gets the provider's native 400. It used to get a mock-internal 500, which SDKs retried and then raised as a generic server error.
- Bedrock `CountTokens` with `input.invokeModel` failed with a 500, because the SDK sends that body base64-encoded. It is now decoded.
- Gemini on Vertex AI: embeddings sent to `:predict` (`text-embedding-*`, `gemini-embedding-001`) are now served instead of returning 404.
- OpenAI Responses: a mid-stream error event now continues the stream's `sequence_number` count instead of sending 0.
- `fakeFromSchema` / `replyFromSchema` fixes:
  - Numbers respect a negative `maximum`, draft-04 boolean and draft-06+ numeric exclusive bounds, and fractional bounds on integers.
  - `maxItems: 0` gives `[]`.
  - An `anyOf` whose only option is `null` gives `null`.
  - `{ violate: true }` now always produces an invalid value. Before, it could return valid data when the schema had no required fields.
- When a scenario expectation and strict mode both fail a test, the Vitest, Jest and Playwright helpers now report both. Before, the expectation failure hid the unmatched-request report.
- `RemoteMockLLM` gives a clear error when the URL isn't a mock-llm server (non-JSON reply), instead of a bare `SyntaxError`.
