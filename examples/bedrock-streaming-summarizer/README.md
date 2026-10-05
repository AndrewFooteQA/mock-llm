# Example: Bedrock streaming summarizer (Vitest)

Streaming summaries with `@aws-sdk/client-bedrock-runtime` (ConverseStream), tested with mock-llm. It shows how to:

- point `BedrockRuntimeClient` at the mock (`endpoint: mock.urls.bedrock`; SigV4 is accepted unverified)
- test token-by-token streaming over AWS's binary event-stream protocol
- assert the model, system prompt and document were sent (`toHaveReceivedRequest`)
- observe each binary frame as it's sent with `mock.on('chunk', …)` (decoded for you)
- use **seeded random latency per rule** (`.latency({ firstTokenMs: { min, max } })`) and assert the recorded delay (`entry.latency`)
- test **mid-stream connection drops**, **in-stream ThrottlingException**, **request-level throttling with SDK retries**, and **time to first token** with simulated latency
- summarise without streaming through **Converse** and **InvokeModel** with Anthropic's native Messages body, stream through
  **InvokeModelWithResponseStream**, and mark summaries cut off at `max_tokens` as truncated
- observe a `fault` event, read the raw exchange from the journal's `wire` record, and give one step a `delay`

```sh
npm install
npm test        # tsc --noEmit (strict, against mock-llm's published types), then vitest
```

| File | What it is |
|---|---|
| `src/summarize.ts` | Streaming summarizer that keeps partial text on failure. Nothing mock-specific. |
| `test/summarize.test.ts` | Tests |

Tip: you don't need to touch code at all. `mock.env()` includes `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, so `new BedrockRuntimeClient({})` finds the mock on its own.
