# mock-llm

Test your LLM-powered app against a local mock that **speaks the real provider APIs**. Your code keeps using the official SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`); you only change the base URL, or just set env vars. You get deterministic responses, scripted tool-call loops and a catalog of faults and awkward outputs. No tokens are spent.

> mock-llm tests how **your application handles** LLM responses: parsing, retries, tool loops, error paths, rendering. It does not measure model quality; that's what evals are for.

## Status

| Provider API | Endpoints |
|---|---|
| **OpenAI**: Chat Completions, Responses API (incl. `previous_response_id`), embeddings, models. Also any OpenAI-compatible API: xAI Grok, Mistral, Groq, DeepSeek, Ollama, vLLM… | `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models` |
| **Anthropic** Messages, count_tokens, models. Also Claude Code and the Claude Agent SDK | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| **Google Gemini**: generateContent / streamGenerateContent, countTokens, embedContent, models. AI Studio and Vertex URL forms | `/v1beta/models/{m}:generateContent` … |
| **AWS Bedrock**: Converse, ConverseStream, InvokeModel, InvokeModelWithResponseStream (Claude, Nova, Llama, Titan/Cohere embeddings), CountTokens. Binary event-stream, served over HTTP/1.1 and HTTP/2 | `/model/{id}/converse` … |

Streaming (SSE), tool calls, thinking blocks, usage, and native error envelopes are covered. Every feature is contract-tested by running the official SDKs against the mock.

## Scope: what mock-llm is not

mock-llm is a **library used inside your test framework** (Vitest, Jest, Playwright, node:test). It controls what the
model does and records what your app sent. It is deliberately **not** a test runner, a reporter or an eval tool:

| Not in scope | Use instead |
|---|---|
| Assertions on your app's output (`toHaveText`, `toMatchSchema`, `toBeValidJSON`) | Your framework's `expect`, plus zod / ajv for schemas |
| Semantic or criteria assertions (`toBeSemanticallySimilarTo`, `toSatisfyCriteria`) | An eval tool. LLM-as-judge is non-deterministic and spends tokens |
| A generic "handles it gracefully" assertion | Assert your app's actual fallback behaviour (message shown, status returned, retry made) |
| Running suites, retries, `--seed` CLI flags, mutation-score runs | Your test runner. Set the seed with the `MOCK_LLM_SEED` env var |
| CLI / HTML test reports | Your framework's reporters. mock-llm exposes the data (journal, usage, cost) |
| Capturing production traffic, OpenTelemetry exporters | Your observability stack. mock-llm emits events and replays fixtures (planned) |
| Switching provider at runtime (`setProvider`) | Your app's SDK picks the provider, so run the same suite once per provider |

The full list, with reasons, is in [`ROADMAP.md`](ROADMAP.md#out-of-scope).

## Install

```sh
npm install --save-dev mock-llm
```

- **Node ≥ 22.** ESM only (`import`, not `require`; a CommonJS build is planned: ROADMAP R14).
- **No runtime dependencies.** The mock speaks the wire protocols itself. Your app keeps its own provider SDKs.
- **Optional peers**, needed only for the features that use them:
  - `yaml` for `.yaml` scenario files (JSON scenarios need nothing);
  - `vitest` for `mock-llm/vitest`;
  - `@jest/globals` for `mock-llm/jest`;
  - `@playwright/test` for `mock-llm/playwright`.
- **Versions:** 0.x, so a minor release (`0.2.0`) may change APIs, and every change is listed in [`CHANGELOG.md`](CHANGELOG.md).
  Pin with `~0.1.0` if you want only patches. Pre-releases are published under the `next` tag (`npm i -D mock-llm@next`).
  Every release is built and published by CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
  see [`RELEASING.md`](RELEASING.md).

Tested against: `openai` 7, `@anthropic-ai/sdk` 0.131, `@google/genai` 2, `@aws-sdk/client-bedrock-runtime` 3,
Vitest 5, Jest 30, Playwright 1.63.

## Quick start

```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createMockLLM, faults, edge } from 'mock-llm';

const mock = await createMockLLM({ seed: 42 });

const openai = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test' });
const claude = new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'test' });
const gemini = new GoogleGenAI({ apiKey: 'test', httpOptions: { baseUrl: mock.urls.gemini } });
const bedrock = new BedrockRuntimeClient({
  endpoint: mock.urls.bedrock,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

mock.when(/refund/i).reply('Refunds take 5 days.');

const r = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'How do refunds work?' }],
});
// r.choices[0].message.content === 'Refunds take 5 days.'

await mock.stop();
```

With Vitest or Jest, `useMockLLM()` starts one mock per file and resets rules and the journal after each test. Importing
the adapter also registers the [matchers](#asserting-on-what-your-app-sent):

```ts
import { useMockLLM } from 'mock-llm/vitest'; // or 'mock-llm/jest' (browser tests: see Playwright)
const mock = useMockLLM({ strict: true });
```

### Jest

`mock-llm/jest` has the same `useMockLLM()` and matchers as `mock-llm/vitest`. Import Jest's APIs from `@jest/globals`.
mock-llm is published as an ES module, so run Jest in ESM mode:

```jsonc
// package.json
"type": "module",
"scripts": { "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js" },
"jest": { "testEnvironment": "node", "transform": {} }
```

Matcher types work both with `expect` from `@jest/globals` and with the global `expect` from `@types/jest`. For TypeScript
test files, keep your existing transform (ts-jest, babel or swc) configured for ESM. A CommonJS build, so Jest's default
setup works without the flag, is on the roadmap (R14). See [`examples/jest-travel-assistant`](examples/jest-travel-assistant).

### Apps you don't construct directly (env vars)

`mock.env()` returns `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, plus dummy keys and credentials. With these set, `new OpenAI()`, `new Anthropic()`, `new GoogleGenAI({})` and `new BedrockRuntimeClient({})` all reach the mock with no code changes. Pass them to a child process to test a whole service, a CLI or **Claude Code** itself (see [`examples/claude-code.mjs`](examples/claude-code.mjs)).

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

`replyFromSchema` reads the schema from OpenAI `response_format` / `text.format`, Anthropic `output_config.format`, or Gemini `responseSchema` / `responseJsonSchema`. It supports objects, arrays, enums, `const`, `anyOf`/`oneOf`/`allOf`, local `$ref`, common `format`s and numeric/length bounds.

**Matchers:** `provider`, `model`, `lastUserMessage`, `system`, `anyMessage` (string = substring, or RegExp), `hasTools`, `tool` (a tool with this name is offered), `tools` (all of these tools are offered), `hasToolResult`, `turn`, `stream`, `responseFormat`, `headers`, and `where: (req) => boolean`.

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

- **OpenAI Responses API:** responses are stored by default, so `previous_response_id` rebuilds the conversation exactly as the real API does. `store: false` disables this, and an unknown id returns a native 400. Refusals become `refusal` content parts; `max_tokens` becomes `status: "incomplete"`.
- **Gemini:** `edge.contentFilter()` maps to `finishReason: SAFETY`. A tool call with string (malformed) arguments maps to `MALFORMED_FUNCTION_CALL`, as Gemini reports it. Mid-stream errors use Gemini's bare JSON error chunk.
- **Bedrock:** SigV4 signatures are accepted without verification (so are bearer API keys). The InvokeModel body shape is chosen by model id: `anthropic.*` (incl. `us.anthropic.*` inference profiles), `amazon.nova*`, `meta.llama*`, `amazon.titan-embed*`, `cohere.embed*`. Other families should use Converse. Errors carry `x-amzn-errortype`, so the SDK raises `ThrottlingException`, `ValidationException`, etc. Stream faults send real event-stream exception frames.

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
  count too. The value is recorded in `entry.latency`.
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
mock.when({}).fail(faults.streamError({ afterChunks: 5 }));  // native in-stream error event
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
const mock = await createMockLLM({ scenarioFiles: ['support-bot.yaml'] });
await mock.load({ rules: [...] });   // or pass a parsed object
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
- **The test fails afterwards.** The Vitest, Jest and Playwright helpers fail it automatically, strict mode or not;
  elsewhere, call `mock.assertExpectations()` or `expect(mock).toHaveMetExpectations()`. The report names the scenario,
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

### Playwright

`mock-llm/playwright` runs **one shared mock for the whole run**. Your app server points at it through env vars, and
browser tests script and inspect it over HTTP through the `llm` fixture.

```js
// playwright.config.mjs
import { defineConfig } from '@playwright/test';
import { mockLLMEnv } from 'mock-llm/playwright';

export default defineConfig({
  workers: 1, // one shared mock: see "Parallel workers" below
  globalSetup: './tests/global-setup.mjs',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4321', env: { ...mockLLMEnv(4010), PORT: '4321' } },
  use: { baseURL: 'http://127.0.0.1:4321', llmStrict: true },
});

// tests/global-setup.mjs
import { startMockLLM } from 'mock-llm/playwright';
export default () => startMockLLM({ port: 4010, strict: true }); // returns the teardown
```

```js
// tests/chat.spec.mjs
import { test, expect } from 'mock-llm/playwright';

test('answers an order question', async ({ page, llm }) => {
  await llm.load({ rules: [{ when: { tool: 'lookup_order' }, toolCall: { name: 'lookup_order', input: { order_id: 'A-1' } } }] });
  await page.goto('/');
  // … drive the UI …
  await expect(llm).toHaveToolTrajectory(['lookup_order']); // matchers are async here
});
```

- **Scripting:** `llm.load({...})` takes the [scenario-file](#scenario-files-yaml--json) format, because function
  responders can't cross processes. `llm` is reset before every test that uses it.
- **Matchers:** all [matchers](#asserting-on-what-your-app-sent) are available as `await expect(llm).…`. They fetch a
  journal snapshot first, which is why they're async.
- **`llmStrict: true`** (an option) fails a test that made an unscripted LLM request, even if the app showed a friendly
  error. Pair it with `startMockLLM({ strict: true })` so the app receives a real 400.
- **`blockRealProviders`** (an option, on by default) fails any test whose browser called a real provider API
  (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `bedrock-runtime.*.amazonaws.com`,
  `api.x.ai`). It guards *browser* traffic only. Your app server is pointed at the mock by `mockLLMEnv()`; hardcoded
  hosts on the server are roadmap R13.
- **`await llm.routeBrowser(page)`** sends browser-direct provider calls (e.g. "bring your own key" UIs) to the mock
  instead. Playwright buffers routed responses, so a stream arrives all at once.
- **Startup order:** Playwright starts `webServer` *before* `globalSetup`. That's fine when the app only calls the LLM
  while handling requests. If your app calls the LLM while booting, the mock isn't up yet; that isn't supported yet.
- **The control API works without Playwright too:** `new RemoteMockLLM(url)` (from `mock-llm`) has `load`, `reset`,
  `journal()` (a local, priced snapshot) and `assertNoUnmatched()`, and `remoteAssertions` has async versions of every
  matcher.

#### Parallel workers

One mock is shared by the whole run, so tests in parallel workers would overwrite each other's rules and share a
journal. **Use `workers: 1` for suites that use the `llm` fixture** (the fixture warns if `workers > 1`). Per-test
isolation, so parallel workers can share one mock, is not supported yet (roadmap R15). See
[`examples/playwright-chat-ui`](examples/playwright-chat-ui).

## Asserting on what your app sent

Importing `mock-llm/vitest` registers matchers that check what your app *sent* to the model, across every provider:

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
| `toHaveMetExpectations(filter?)` | Every scenario expectation step was met (see [Expectation steps](#expectation-steps)) |

- **Matching:** expected values match like `toMatchObject` (objects partially), and RegExps and asymmetric matchers (`expect.stringContaining(...)`) work anywhere.
- **Filters:** every matcher takes a `filter` (`{ provider, model, endpoint }`). Only chat requests count unless `endpoint: 'any'`.
- **`.not`:** all matchers support `.not`. On failure, the message shows an excerpt of the requests: system prompt, last user message, tools offered, tool results sent, and what the mock replied.
- **Naming:** these names deliberately avoid Vitest's and Jest's built-in spy matchers (`toHaveBeenCalled*`), so your spies keep working.
- **Jest:** `mock-llm/jest` registers the same matchers (see [Jest](#jest)).
- **Playwright:** `mock-llm/playwright`'s `expect` has them as async matchers (`await expect(llm)…`; see [Playwright](#playwright)).
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

## Options

```ts
createMockLLM({
  port: 0,                 // ephemeral by default
  host: '127.0.0.1',       // localhost only by default
  seed: 1,                 // deterministic lorem, ids, chaos, latency; MOCK_LLM_SEED overrides it; see mock.seed
  latency: { firstTokenMs: 300, tokensPerSec: 50 },  // simulate slowness (off by default); firstTokenMs may be { min, max } or normal
  apiKeys: ['test-key'],   // enforce keys → native 401 otherwise
  models: ['gpt-4o', 'claude-sonnet-5-5'],           // models endpoints
  chaos: { rate: 0.05 },
  strict: true,            // unscripted requests get a 400 and fail the test (see Strict mode)
  onUnmatched: 'error',    // 400 for unscripted requests, without failing the test (default: canned reply)
  pricing: { 'gpt-4o': { input: 2.5, output: 10 } }, // USD per 1M tokens
  contextWindow: { 'gpt-4o': 128_000, '*': 8_000 },  // native context-length errors; tokens are APPROXIMATE
                                                     // (~4 chars/token, input only; see Context window)
  scenarioFiles: ['qa/scenarios.yaml'],
});
```

Token counts are approximate (~4 chars/token): good for budget assertions, not billing.

## Example projects

[`examples/`](examples) has standalone starter projects, one per provider plus an end-to-end service and Claude Code.
Each pairs real app code with a test suite. Run them all with `npm run test:examples`.

| Example | Also shows |
|---|---|
| [`openai-support-bot`](examples/openai-support-bot) | Strict mode, context window, seeded chaos (errors + content), request/prompt/token matchers |
| [`claude-tool-agent`](examples/claude-tool-agent) | Tool trajectory and tool result matchers, model-glob + `tools` rules |
| [`gemini-structured-extraction`](examples/gemini-structured-extraction) | Schema-generated output, schema violations, request/prompt matchers |
| [`bedrock-streaming-summarizer`](examples/bedrock-streaming-summarizer) | Binary event stream, events (`mock.on('chunk')`), per-rule seeded latency, request matcher |
| [`node-service-e2e`](examples/node-service-e2e) | `node:test`, `mock.env()`, YAML scenario file with expectation steps, assertions as plain functions |
| [`jest-travel-assistant`](examples/jest-travel-assistant) | **Jest** (ESM), OpenAI Responses API tool loop + memory, strict mode, matchers |
| [`playwright-chat-ui`](examples/playwright-chat-ui) | **Playwright** full-stack: server + browser-direct calls, `routeBrowser`, real-provider guard, strict mode, async matchers, mid-stream UI via exact chunks |
| [`claude-code-cli`](examples/claude-code-cli) | The real Claude Code CLI against the mock |

The full feature list per example is in [`examples/README.md`](examples/README.md).

## Docs & live playground

```sh
npm run playground   # → http://localhost:4317
```

The playground has three sections:

- **Tutorial:** 14 runnable lessons.
- **Playground:** a free-form scenario editor.
- **Reference:** the API, partly generated from the library itself.

Each run starts a fresh mock and calls it with the official SDK for the provider you pick: OpenAI Chat, OpenAI Responses, Claude, Gemini or Bedrock. A real agent loop runs the tool calls. Results appear in five tabs:

- the conversation, streamed live
- what the SDK returned or threw
- the raw wire traffic (Bedrock's binary event stream is decoded)
- the journal and simulated cost
- the equivalent app code

## Development

```sh
npm install
npm test                  # unit + contract tests (official SDKs against the mock)
npm run playground:check  # every tutorial lesson × variant × provider
npm run test:examples     # every example project, against a fresh build (Playwright example: run `npx playwright install chromium` once)
npm run check             # all of the above + typecheck
```

Contributing and releasing: see [`CONTRIBUTING.md`](CONTRIBUTING.md) (every PR that changes the package adds a changeset) and [`RELEASING.md`](RELEASING.md).

Planned work and its acceptance criteria live in [`ROADMAP.md`](ROADMAP.md); each item is signed off before the next starts. Every change ships with tests, updated docs and tutorial, and updated examples. See [`CLAUDE.md`](CLAUDE.md) for the full definition of done. When working with Claude Code, a project Stop hook (`.claude/settings.json`) enforces it by running `npm run check` before Claude finishes.

Adding a provider means implementing the `Adapter` interface in `src/providers/adapter.ts` (parse → IR, render IR → wire format, native errors) and adding contract tests that use that provider's official SDK.

## License

MIT
