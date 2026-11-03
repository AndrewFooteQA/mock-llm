# Scripting responses

[README](../README.md) · [Setup](setup.md) · [Scripting](scripting.md) · [Failures](failures.md) · [Assertions](assertions.md)

Rules, matchers, tool loops, streaming, latency, scenario files and per-request scenarios.

## Scripting responses

```ts
mock.when('hello').reply('Hi!');                                    // substring of last user message
mock.when({ provider: 'anthropic', model: /sonnet/ }).reply('...');  // structured matcher
mock.when({ system: 'pirate' }).replyTemplate('Arr, {{lastUserMessage}}');
mock.when({}).replyEcho();
mock.when({}).replyLorem({ tokens: 200 });
mock.when({ responseFormat: 'json_schema' }).replyJson({ ok: true });
mock.when({ responseFormat: 'json_schema' }).replyFromSchema();               // valid JSON generated from the request's schema
mock.when({ responseFormat: 'json_schema' }).replyFromSchema({ violate: true }); // JSON that breaks the schema
mock.when({ hasTools: true }).replyToolCallFromSchema('lookup');             // tool args generated from the tool's schema
mock.when({}).reply('42', { thinking: 'Let me think…' });           // thinking block (Anthropic)
mock.when({}).reply((req) => `You sent ${req.messages.length} messages`);
mock.default().reply('fallback');                                  // when nothing matches
```

`replyFromSchema` reads the schema from OpenAI `response_format` / `text.format`, Anthropic `output_config.format`, or Gemini `responseSchema` / `responseJsonSchema`. It supports objects, arrays, enums, `const`, `anyOf`/`oneOf`/`allOf`, local `$ref`, common `format`s and numeric/length bounds (including draft-04 boolean and draft-06+ numeric `exclusiveMinimum` / `exclusiveMaximum`). `{ violate: true }` always produces a value that fails validation: it drops a required field, or else gives a property the wrong type, or else returns a non-object.

The same generator is exported for your own fixtures, e.g. to unit-test a validator: `fakeFromSchema(schema, { seed, violate })`
returns a deterministic value. The same schema and seed always give the same value, and the default seed is 1.

**Matchers:** `provider`, `model`, `lastUserMessage`, `system`, `anyMessage` (string = substring, or RegExp; a `g` / `y` flag is harmless, since every request is tested from the start), `hasTools`, `tool` (a tool with this name is offered), `tools` (all of these tools are offered), `hasToolResult`, `turn`, `stream`, `responseFormat`, `speed` (Claude fast mode, `'standard' | 'fast'`; a request without it counts as `'standard'`), `headers`, and `where: (req) => boolean`.

**Model globs:** a `model` string containing `*` or `?` is a glob over the whole model id, so one rule can cover a family across providers:

```ts
mock.when({ model: 'claude-*' }).reply('…');            // claude-opus-5-5, claude-sonnet-5-5, …
mock.when({ model: '*claude-*' }).reply('…');           // also Bedrock ids like us.anthropic.claude-sonnet-5-5
mock.when({ model: 'gpt-4?', tools: ['search', 'purchase'] }).reply('…'); // gpt-4o offering both tools
```

Without a wildcard, a `model` string still matches as a substring. Assertion filters (`{ model: 'claude-*' }`) use the same rules.

**Precedence:** the **most recently added** matching rule wins, so per-test rules override shared ones. Register specific rules *after* general ones. `.times(n)` / `.once()` let a rule expire and fall through.

### Agent / tool loops

Each `reply*`/`fail` call appends a step. Requests walk through the steps, and the last step repeats.

```ts
mock.when({ tool: 'get_weather' })
  .replyToolCall('get_weather', { city: 'Paris' })
  .then.reply('It is sunny in Paris.');

// or route on conversation state:
mock.when({ tool: 'get_weather' }).replyToolCall('get_weather', { city: 'Paris' });
mock.when({ hasToolResult: true }).reply('It is sunny in Paris.');
```

`replyToolCalls([...])` emits parallel tool calls.

### Provider-specific notes

- **All providers:** a request body the mock can't read (e.g. a `null` message) gets the provider's native 400 error, like the real API, so SDKs raise their bad-request error and don't retry.
- **OpenAI Responses API:** responses are stored by default, so `previous_response_id` rebuilds the conversation exactly as the real API does. `store: false` disables this, and an unknown id returns a native 400. Refusals become `refusal` content parts; `max_tokens` becomes `status: "incomplete"`.
- **Anthropic:** `role: "system"` messages (sent by Claude Code, typed by SDK 1.x) join the system prompt. Responses carry the fields SDK 1.x (API version 2026-10-21) types as always present: `usage.speed` is `"standard"`, or `"fast"` when the request asks for it, and model objects have `capabilities`, `lifecycle`, `line`, `deprecated_at` and `retires_at` (set with the [`models` option](setup.md#models-lifecycle-and-capabilities-claude); default: active, every capability, `line` from Claude ids). Older SDKs ignore the extra fields; `temperature` / `top_p` / `top_k` are still accepted for them.
  **Thinking config** shapes the reply: with `thinking: { type: "disabled" }` scripted `{ thinking }` blocks are left out; with `"between_tools"` (no up-front thinking) a scripted thinking block comes back only as the *progress update* directly before the tool call it introduces, at most one per call, so a reply without tool calls is text only. `adaptive`, `enabled` or no `thinking` field: unchanged. The same applies to Claude bodies on Bedrock `InvokeModel`. Rejections are covered in [Model lifecycle and thinking errors](failures.md#model-lifecycle-and-thinking-errors-claude).
- **Gemini:** `edge.contentFilter()` maps to `finishReason: SAFETY`. A tool call with string (malformed) arguments maps to `MALFORMED_FUNCTION_CALL`, as Gemini reports it. Mid-stream errors use Gemini's bare JSON error chunk. On Vertex AI, embeddings for non-Gemini models (`text-embedding-*`, `gemini-embedding-001`) go to `:predict`, the rest to `:embedContent`; both are served.
- **Bedrock:** SigV4 signatures are accepted without verification (so are bearer API keys). The InvokeModel body shape is chosen by model id: `anthropic.*` (incl. `us.anthropic.*` inference profiles), `amazon.nova*`, `meta.llama*`, `amazon.titan-embed*`, `cohere.embed*`. Other families should use Converse. Errors carry `x-amzn-errortype`, so the SDK raises `ThrottlingException`, `ValidationException`, etc. Stream faults send real event-stream exception frames. CountTokens accepts `input.converse` or `input.invokeModel` (whose `body` the SDK sends base64-encoded).

### Exact stream chunks

By default, replies stream in word-sized pieces. To control the exact pieces, for example to test how a UI renders
partial text, a split emoji, or a JSON object arriving in fragments, pass `chunks`:

```ts
mock.when({}).reply({ chunks: ['{"sta', 'tus": "ok', '"}'] });             // streamed exactly as given
mock.when({}).reply({ chunks: ['Thinking', '…', ' done'] }, { chunkIntervalMs: 300 }); // with a fixed pause
```

- **Every provider:** the pieces arrive as the SDK's text deltas for OpenAI Chat and Responses, Anthropic, Gemini and
  Bedrock (Converse and InvokeModel).
- **Non-streaming requests** get the joined text.
- **`chunkIntervalMs`** pauses between streamed events, overriding `tokensPerSec`. Protocol framing events (start/stop)
  count too. The value is recorded in `entry.latency`. To assert an intermediate UI state in a browser test, use a pause
  above ~1 s. Playwright's assertion retries back off to 1 s, so a shorter state can fall between two polls.
- **In YAML:** `reply: { chunks: [...] }` plus an optional `chunkIntervalMs:` on the step.
- **With `inject()`:** suffix text arrives as its own final chunk; prefix text joins the first chunk.

### Latency

Latency is off by default, so tests stay fast. Add it to test spinners, timeouts, cancellation and streaming UX:

```ts
createMockLLM({ latency: { firstTokenMs: 300, tokensPerSec: 50 } });            // every reply
mock.when('search').latency({ firstTokenMs: { min: 200, max: 800 } }).reply('…'); // this rule (uniform, seeded)
mock.when({}).latency({ firstTokenMs: { distribution: 'normal', mean: 1200, stdDev: 400 } }).reply('…');
mock.when({}).reply('Searching…', { delay: 100 }).then.reply('Found it', { delay: 500 }); // per step
```

- **Precedence:** a step's `delay` overrides the rule's `.latency()`, which overrides the global `latency`.
- **Delay formats:** `firstTokenMs` / `delay` take ms, `{ min, max }`, or `{ distribution: 'normal', mean, stdDev }` (clamped at 0).
  `tokensPerSec` sets the streaming speed.
- **Reproducible:** random delays come from a separate stream seeded by `seed`, so the same seed gives the same delays,
  and turning latency on doesn't change generated text or ids.
- **Assertable:** each journal entry records the delay actually applied (`entry.latency`), so you can assert timing
  without flaky wall-clock checks.
- **Faults:** error faults respond immediately; stream faults (`streamCut`, `streamError`) honour rule and global latency.

## Scenario files (YAML / JSON)

QA can script a mock without writing code:

```yaml
# support-bot.yaml
rules:
  - when: { lastUserMessage: "/refund/i" }   # "/…/flags" = regex, otherwise substring
    reply: Refunds take 5 business days.
  - when: { tool: get_weather }
    steps:                                    # sequence: one step per request
      - toolCall: { name: get_weather, input: { city: Paris } }
      - reply: It is sunny in Paris.
  - when: { lastUserMessage: flaky }
    once: true
    fail: { rateLimit: { retryAfter: 2 } }    # any faults.* by name
  - when: { lastUserMessage: weird }
    edge: unicode                             # any edge.* by name
    inject: " [INJECTED]"
scenarios:
  vip: { template: "Welcome back! {{lastUserMessage}}" }
default:
  lorem: { tokens: 40 }
```

```ts
const mock = await createMockLLM({ scenarioFiles: ['support-bot.yaml'] }); // re-applied by every reset()
await mock.load({ rules: [...] });   // or pass a parsed object; cleared by reset()
```

### Expectation steps

A step can also **check the request it answers**. That lets a scenario file describe an agent trajectory, including
what your app must send back:

```yaml
rules:
  - name: refund-flow
    when: { tool: lookup_order }
    steps:
      - toolCall: { name: lookup_order, input: { order_id: A-1 } }
      - expectToolResult: { name: lookup_order, content: { refundable: true } } # what the app's tool returned
        expectRequest: { system: "/acme support/i" }                           # partial match, "/…/" = RegExp
        reply: You're eligible for a refund.
```

- **What gets checked:** `expectToolResult` uses `toHaveReturnedToolResult`; `expectRequest` uses `toHaveReceivedRequest`.
  Both run on just the request that step answers.
- **Failures don't break the app:** the reply is still sent and the result is recorded on the journal entry
  (`entry.expectations`).
- **The test fails afterwards.** The Vitest, Jest and Playwright helpers fail it automatically, strict mode or not (if
  strict mode also finds unmatched requests, both reports are shown); elsewhere, call `mock.assertExpectations()` or `expect(mock).toHaveMetExpectations()`. The report names the scenario,
  rule and step:

```text
SCENARIO EXPECTATION FAILED: 1 expectation(s) not met.

  support.yaml: rules[0] ("refund-flow") › steps[1]: expectToolResult (request #2)
      Expected mock-llm to have returned a tool result for "lookup_order" matching {"refundable":true}; …
```

- **In code:** `reply(text, { expectToolResult, expectRequest })` works the same; locations read `rule "refund" › step 2`.

Step actions: `reply`, `template`, `json`, `echo`, `lorem`, `toolCall`, `toolCalls`, `fromSchema`, `toolCallFromSchema`, `edge`, `fail`. Modifiers: `stopReason`, `thinking`, `usage`, `delay`, `chunkIntervalMs`, `expectToolResult`, `expectRequest` (the last four not on `fail`). `reply` also takes `{ chunks: [...] }` (see [Exact stream chunks](#exact-stream-chunks)). Rules also take `latency: { firstTokenMs, tokensPerSec }` (see [Latency](#latency)). Unknown keys, matchers, faults and edge cases are rejected with a message naming the bad entry. YAML needs the optional `yaml` package; JSON works without it.

## Per-request scenarios (no code changes)

Select a scenario for a single request with a header or a token in the prompt. This is handy for end-to-end and manual QA:

```
x-mock-scenario: rate-limit
```
```
"Summarise this [[mock:truncated]]"
```

Built-in: `bad-request`, `auth-error`, `permission-denied`, `not-found`, `context-length`, `request-too-large`, `rate-limit`, `server-error`, `overloaded`, `timeout`, `connection-reset`, `stream-cut`, `stream-error`, `empty`, `truncated`, `refusal`, `content-filter`, `unicode`, `prompt-injection`, `pii`, `long`, `code-fenced-json`, `almost-json`, `malformed-tool-args`, `hallucinated-tool`, `wrong-tool-args`.

Define your own with `mock.scenario('vip').reply('Welcome back!')`. The header `x-mock-inject: <text>` appends text to any reply.
