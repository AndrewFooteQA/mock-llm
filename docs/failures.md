# Failures: faults, chaos and awkward outputs

[README](../README.md) · [Setup](setup.md) · [Scripting](scripting.md) · [Failures](failures.md) · [Assertions](assertions.md)

Native provider errors, seeded chaos, context limits and the replies that break parsers.

## Faults (negative testing)

Errors render in each provider's **native** status code and error body, so the SDKs raise their real exception classes (`RateLimitError`, `AuthenticationError`, …) and run their real retry logic.

```ts
mock.when({}).once().fail(faults.rateLimit({ retryAfter: 2 })); // 429 + retry-after
mock.when({}).fail(faults.overloaded());          // Anthropic 529 / OpenAI & Gemini 503 / Bedrock ServiceUnavailableException
mock.when({}).fail(faults.contextLengthExceeded());
mock.when({}).fail(faults.authError());            // also: badRequest, permissionDenied, notFound, serverError, requestTooLarge
mock.when({}).fail(faults.timeout());              // never answers → client timeout
mock.when({}).fail(faults.connectionReset());
mock.when({}).fail(faults.streamCut({ afterChunks: 5 }));    // drop mid-stream
mock.when({}).fail(faults.streamError({ afterChunks: 5 }));  // native in-stream error event, sent ~50 ms after chunk 5
mock.when({}).fail(faults.raw(418, { anything: 'goes' }));

// random, but seeded so it reproduces:
const mock = await createMockLLM({ seed: 1, chaos: { rate: 0.1 } });
```

### Chaos (errors and bad content)

`chaos: { rate }` makes a seeded fraction of chat requests misbehave. By default it injects errors only. `weights` adds
**content chaos**, where the model returns a bad answer instead of an error:

```ts
createMockLLM({
  seed: 2024,
  chaos: { rate: 0.2, weights: { error: 1, refusal: 1, empty: 1, truncated: 2, malformedToolCall: 1 } },
});
```

| Behaviour | What happens |
|---|---|
| `error` | A fault from `faults` (default: 429, overloaded, 500) instead of any reply. The error names the seed |
| `refusal` | The model refuses |
| `empty` | Empty content |
| `truncated` | *Your scripted reply* cut off at `max_tokens` (text, or a tool call's JSON arguments) |
| `malformedToolCall` | *Your scripted* tool call's arguments become invalid JSON, or the first offered tool is called with broken arguments. Only when the request offers tools |

- **Content chaos changes the scripted reply:** your rule still runs and its sequence advances, so `truncated` cuts
  *that* text.
- **Inapplicable behaviours are skipped:** chaos picks only among behaviours that apply (no `malformedToolCall` without tools).
- **Journal:** each affected entry records `entry.chaos = { seed, behaviour }`, and matcher failures show it.
- **Reproducible:** the same seed gives the same sequence of behaviours. Errors-only chaos keeps the exact random
  sequence it had before `weights` existed.

### Reproducing a run (`MOCK_LLM_SEED`)

Everything random in mock-llm (lorem text, ids, schema values, chaos and random latency) comes from one seed, so a run
can be replayed exactly:

```sh
MOCK_LLM_SEED=2024 npm test   # overrides every mock's `seed` option for this run
```

- **Which seed:** `mock.seed` is the effective seed: `MOCK_LLM_SEED` if set, else the `seed` option, else 1. Include it in
  your own assertion messages, e.g. `expect(x, \`seed ${mock.seed}\`)`.
- **Strict mode:** the UNEXPECTED LLM REQUEST report ends with `reproduce this run with MOCK_LLM_SEED=…`.
- **Chaos faults:** the error your app receives carries a short note,
  `[mock-llm chaos fault · seed N · reproduce with MOCK_LLM_SEED=N]`. Its native type, status and envelope are unchanged.
  Matcher failure messages add the same hint when chaos affected a request, and `entry.chaos = { seed }` marks those
  journal entries. Regular (non-chaos) faults keep their exact native message.

### Context window

Simulate model context limits so oversized prompts fail the way they would in production:

```ts
createMockLLM({ contextWindow: { 'gpt-4o': 128_000, 'claude-*': 200_000, '*': 8_000 } });
```

- **When it triggers:** a chat request whose input exceeds its model's window gets the provider's **native**
  context-length error, with real numbers. OpenAI: `BadRequestError`, code `context_length_exceeded`. Anthropic:
  `prompt is too long: N tokens > L maximum`. Gemini: `INVALID_ARGUMENT`. Bedrock: `ValidationException`.
- **Order:** it applies **before** rules and scenarios, because a real provider rejects an oversized prompt whatever
  reply you scripted. The journal records it as a fault (`matchedBy: 'contextWindow'`, `fault.error.details`), and it
  isn't counted as unmatched.
- **Which key applies:** an exact model id wins, then the longest matching glob. Non-wildcard keys match only that exact id.
- **Approximate counting:** about 4 characters per token, counting the system prompt, the whole conversation (including
  Responses API history) and tool definitions; output `max_tokens` isn't counted. Use it to test *how your app handles*
  the limit, not to predict exact provider token counts.

`faults.contextLengthExceeded({ details: { limit, inputTokens } })` gives the same error on demand, for a single rule.

## Awkward outputs (edge cases)

```ts
mock.when({}).reply(edge.empty());
mock.when({}).reply(edge.truncated(json));          // stop_reason max_tokens / finish_reason length
mock.when({}).reply(edge.refusal());
mock.when({}).reply(edge.contentFilter());
mock.when({}).reply(edge.codeFencedJson({ ok: 1 })); // ```json … ``` with chatter around it
mock.when({}).reply(edge.almostJson({ ok: 1 }));    // trailing comma, single quotes
mock.when({}).reply(edge.unicode());                // emoji, RTL, zalgo, zero-width
mock.when({}).reply(edge.promptInjection());        // XSS / SQL / template-injection strings
mock.when({}).reply(edge.piiLike());
mock.when({}).reply(edge.long(20000));
mock.when({}).reply(edge.malformedToolArgs('get_weather'));
mock.when({}).reply(edge.hallucinatedTool());
mock.when({}).reply(edge.wrongToolArgTypes('get_weather'));

// add your own text to otherwise-normal replies:
mock.when({}).reply('Your order shipped.').inject(' <script>alert(1)</script>');
```
