---
"mock-llm": patch
---

Anthropic: responses include the fields `@anthropic-ai/sdk` 1.x (API version 2026-10-21) types as always present.
`usage.speed` is `"standard"`, or `"fast"` when the request asks for it (first-party API only, not Bedrock). Model objects
from `models.list()` / `models.retrieve()` carry `lifecycle: "active"`, `line` (`opus`, `sonnet`, … for Claude ids,
otherwise `null`), `deprecated_at: null` and `retires_at: null`.
