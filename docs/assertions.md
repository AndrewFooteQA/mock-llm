# Assertions: matchers, strict mode, journal

[README](../README.md) · [Setup](setup.md) · [Scripting](scripting.md) · [Failures](failures.md) · [Assertions](assertions.md)

Checking what your app sent, failing on unscripted requests, and inspecting every exchange.

## Asserting on what your app sent

Importing `mock-llm/vitest` registers matchers that check what your app *sent* to the model, across every provider.
Their TypeScript types work on Vitest 4 and 5. On Vitest 4, keep `skipLibCheck: true` (the default in `tsc --init` and the
Vite / Vitest templates): Vitest 4 and 5 declare the matcher interface differently, so one of the two declarations
mock-llm ships always mismatches when library files are checked.

```ts
import { useMockLLM } from 'mock-llm/vitest';
const mock = useMockLLM();

// ... run your agent ...

expect(mock).toHaveReceivedRequest({ model: 'claude-opus-5-5', system: expect.stringContaining('support') });
expect(mock).toHaveReceivedRequestTimes(3);
expect(mock).toHaveReceivedPrompt(/refund/i, { in: 'user' });

expect(mock).toHaveOfferedTool('lookup_order');                       // in the request's tool list
expect(mock).toHaveRequestedTool('lookup_order', { order_id: 'A-1' }); // mock → app: the model asked for it
expect(mock).toHaveReturnedToolResult('lookup_order', { status: 'shipped' }); // app → mock: your code ran it
expect(mock).toHaveToolTrajectory(['search', 'get_product', 'purchase']);
expect(mock).toHaveToolTrajectory(['get_product'], { mode: 'subsequence' });

expect(mock).toHaveUsedTokensLessThan(5_000);
expect(mock).toCostLessThan(0.05); // USD, from the journal's pricing
```

| Matcher | Passes when |
|---|---|
| `toHaveReceivedRequest(expected?)` | Any chat request was received; with `expected`, one matches it partially (`model`, `provider`, `system`, `lastUserMessage`, `tools` (names), `stream`, `maxTokens`, `temperature`, `responseFormat`, `headers`, `messages`) |
| `toHaveReceivedRequestTimes(n, filter?)` | Exactly `n` chat requests were received |
| `toHaveReceivedPrompt(text, { in? })` | A system prompt or user message matches. `in`: `'any'` (default), `'system'`, `'user'`, `'lastUser'` |
| `toHaveOfferedTool(name)` | A request included the tool in its tool list |
| `toHaveRequestedTool(name, args?)` | The **mock** returned a call to the tool (args matched partially) |
| `toHaveReturnedToolResult(name, expected?)` | **Your app** sent back a result for the tool. Strings and RegExps match the raw content; objects match parsed JSON partially |
| `toHaveToolTrajectory(steps, { mode?, source? })` | The ordered tools your app ran (`source: 'returned'`, default) or the mock requested (`'requested'`). `mode: 'exact'` (default) or `'subsequence'`; steps can be names or `{ name, args }` |
| `toHaveUsedTokensLessThan(n, { kind? })` | Simulated tokens are below `n`. `kind`: `'total'` (default), `'input'`, `'output'` |
| `toCostLessThan(usd, { allowUnpriced? })` | Simulated cost is below `usd`. Fails if a model has no price, rather than guessing $0 |
| `toHaveNoUnmatchedRequests(filter?)` | Every chat request was scripted by a rule, scenario or `default()` (see [Strict mode](#strict-mode)) |
| `toHaveMetExpectations(filter?)` | Every scenario expectation step was met (see [Expectation steps](scripting.md#expectation-steps)) |

- **Matching:** expected values match like `toMatchObject` (objects partially), and RegExps and asymmetric matchers (`expect.stringContaining(...)`) work anywhere.
- **Filters:** every matcher takes a `filter` (`{ provider, model, endpoint }`). Only chat requests count unless `endpoint: 'any'`.
- **`.not`:** all matchers support `.not`. On failure, the message shows an excerpt of the requests: system prompt, last user message, tools offered, tool results sent, and what the mock replied.
- **Naming:** these names deliberately avoid Vitest's and Jest's built-in spy matchers (`toHaveBeenCalled*`), so your spies keep working.
- **Jest:** `mock-llm/jest` registers the same matchers (see [Jest](setup.md#jest)).
- **Playwright:** `mock-llm/playwright`'s `expect` has them as async matchers (`await expect(llm)…`; see [Playwright](setup.md#playwright)).
- **Other frameworks:** the same checks are plain functions exported from `mock-llm` (`toHaveOfferedTool(mock, 'x')` returns `{ pass, message }`), so any framework can wrap them.

## Strict mode

By default an unscripted chat request gets a canned reply, so tests keep moving. In CI you usually want the opposite:
**an LLM request you didn't plan for should fail the test**, even if your app catches the error and carries on.

```ts
const mock = useMockLLM({ strict: true }); // mock-llm/vitest
```

In strict mode, a chat request that no rule, scenario or `default()` matches:

1. gets the provider's native **400** error. SDKs never retry 400s, so one surprise means one request, not a retry storm;
2. is flagged `unmatched: true` in the journal;
3. **fails the test** after it runs, even if your app swallowed the error, with a report like:

```text
UNEXPECTED LLM REQUEST: 1 request(s) matched no rule.

  #2 openai gpt-4o
      system: "You are Acme support."
      last user: "Where is my order A-1001?"
      tools offered: lookup_order
      add: mock.when({ provider: 'openai', lastUserMessage: "Where is my order A-1001?" }).reply('…');

Script them with mock.when(...), or add a fallback with mock.default().reply(...).
```

Outside Vitest, call `mock.assertNoUnmatched()` yourself (it throws `UnmatchedRequestError`), or use
`expect(mock).toHaveNoUnmatchedRequests()`. Unmatched requests are flagged even without `strict`, so both checks also
work in non-strict suites. Only chat requests count: models, token-counting and embeddings endpoints have built-in
answers. A chaos-injected fault still counts as unmatched if nothing scripted the request.

## Assertions: the journal

Every exchange is also recorded in a provider-neutral form you can inspect directly:

```ts
const last = mock.journal.last()!;
expect(last.request.system).toContain('You are');
expect(last.request.tools.map((t) => t.name)).toContain('get_weather');
expect(mock.journal.count({ provider: 'openai' })).toBe(3);
expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]); // SDK retried
expect(mock.journal.usage().inputTokens).toBeLessThan(5000);        // token budget
```

Out-of-process clients can use the HTTP control API: `GET /__mock/info`, `GET /__mock/journal`, `POST /__mock/reset`, `POST /__mock/load` (a scenario-file object), or the `RemoteMockLLM` client. Requests to paths a provider doesn't serve (e.g. Claude Code's `HEAD /api/hello` probe) are recorded with `endpoint: 'unknown'` and answered with that provider's native 404.

### Events

Subscribe to mock activity as it happens. This is useful for logging, custom reporters, or piping into your own tracing:

```ts
mock.on('request', ({ entry }) => log(`→ ${entry.provider} ${entry.request.model}`));
mock.on('chunk', ({ entry, index, text }) => progress(entry.id, index, text));
mock.on('response', ({ entry }) => log(`← ${entry.status} in ${entry.durationMs}ms`));
mock.on('fault', ({ entry, fault }) => log(`✗ ${fault.type}`));
mock.on('unmatched', ({ entry }) => log(`unscripted: ${entry.request.model}`));
mock.off('request', handler);
```

- **Order:** guaranteed per request: `request → unmatched? → chunk* → response | fault`, with exactly one terminal event, even for validation errors and client timeouts.
- **Terminal events:** `fault` fires when an injected fault ended the exchange; `response` fires otherwise, at any status.
- **Chunks:** `chunk` fires for each streamed piece as sent. `data` is the raw string or bytes; `text` is readable, with Bedrock's binary event-stream frames decoded.
- **Payloads:** `entry` is the live journal entry.
- **Safety:** a listener that throws or rejects never affects the response your app receives; it's reported through `console.error`.
- **Lifetime:** listeners survive `reset()`.

### Simulated cost

```ts
const cost = mock.journal.cost();
// { total: 0.0123, byModel: { 'claude-opus-5-5': { inputTokens, outputTokens, usd } }, unpriced: ['gpt-4o'] }
expect(cost.total).toBeLessThan(0.05);   // "this flow must cost under 5 cents"
```

Claude list prices are built in (Anthropic first-party, as of 2026-09-25). Other providers' prices change often and vary by tier and region, so they are not bundled. Supply them yourself as USD per 1M tokens, keyed by model id or id fragment:

```ts
createMockLLM({ pricing: { 'gpt-4o': { input: 2.5, output: 10 }, 'gemini-2.5-flash': { input: 0.3, output: 2.5 } } });
```

Models with usage but no price are listed in `unpriced` rather than counted as $0.
