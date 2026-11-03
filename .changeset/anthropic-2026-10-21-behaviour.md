---
"mock-llm": minor
---

Claude API 2026-10-21 behaviour (`@anthropic-ai/sdk` 1.x):

- **Thinking config shapes the reply.** `thinking: { type: "disabled" }` leaves out scripted `{ thinking }` blocks.
  `"between_tools"` has no up-front thinking: a scripted thinking block comes back only as the progress update directly
  before the tool call it introduces. Also for Claude bodies on Bedrock `InvokeModel`.
- **`speed` matcher** (`when({ speed: 'fast' })`, YAML too); a request without `speed` counts as `'standard'`. The
  journal and `toHaveReceivedRequest` see `request.speed`.
- **`models` option takes `ModelSpec` entries** (`{ id, lifecycle, deprecatedAt, retiresAt, line, displayName,
  capabilities }`). Model objects now carry `capabilities` (every key, default all supported). `models.list()` honours
  the `lifecycle` filter and hides retired models by default. A Messages request naming a retired model gets a 404
  `not_found_error` (the API doesn't document this error, so its shape is unverified). A thinking type a model's
  `capabilities` mark unsupported gets the API's documented 400 message. Malformed thinking config (`between_tools` with
  other fields, `display` with `disabled`, an unknown type) gets a 400.

Behaviour change: a request that sends `thinking: { type: "disabled" }` or `"between_tools"` no longer receives scripted
thinking blocks it would not get from the API. Requests without those settings are unchanged.
