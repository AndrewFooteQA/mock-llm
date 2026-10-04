# mock-llm

## 0.2.0

### Minor Changes

- 8cfe162: Supported versions are now tested, not assumed. A compatibility matrix runs each provider SDK, test framework and
  TypeScript at its oldest supported and latest release, and the README's new **Compatibility** table is generated from its
  results.
  
  **Breaking: the optional peer dependency ranges are narrowed to what is tested.**
  
  - `vitest`: `>=4.0.1` (was `>=1`)
  - `@playwright/test`: `>=1.56` (was `>=1.40`)
  
  `@jest/globals` (`>=29`) and `yaml` (`>=2`) are unchanged. To migrate, upgrade Vitest or Playwright if you're below these.
  Older versions were never tested, and npm now warns about them.
  
  Supported provider SDK floors (compatibility claims, not peer dependencies):
  
  - `openai` ≥ 6.0.0
  - `@anthropic-ai/sdk` ≥ 0.66.0
  - `@google/genai` ≥ 1.6.0
  - `@aws-sdk/client-bedrock-runtime` ≥ 3.906.0
  
  Published types are checked with TypeScript ≥ 6.0.2.

### Patch Changes

- 8cfe162: Bug fixes:
  
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

## 0.1.1

### Patch Changes

- 91ac0d8: No library changes. This is the first release published through npm trusted publishing: CI publishes with no npm token, and
  every version carries a provenance attestation linking it to the GitHub commit and workflow that built it.

## 0.1.0

First public release.

- Native mocks of the OpenAI (Chat Completions + Responses), Anthropic Messages, Google Gemini and AWS Bedrock APIs
  (streaming, tool calls, native errors), verified against the official SDKs.
- Rule engine, sequences, faults, edge cases, chaos (errors + content), latency, exact stream chunks, context windows,
  scenario files (YAML/JSON) with expectation steps, journal with wire recording and cost estimates.
- Test-framework integrations: `mock-llm/vitest`, `mock-llm/jest`, `mock-llm/playwright` (fixtures, matchers, strict mode).
- Live docs playground and example projects.
