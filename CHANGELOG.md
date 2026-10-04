# mock-llm

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
