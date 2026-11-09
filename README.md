# mock-llm

[![npm](https://img.shields.io/npm/v/mock-llm)](https://www.npmjs.com/package/mock-llm) [![CI](https://github.com/AndrewFooteQA/mock-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/AndrewFooteQA/mock-llm/actions/workflows/ci.yml) [![Compatibility](https://github.com/AndrewFooteQA/mock-llm/actions/workflows/compat.yml/badge.svg)](#compatibility) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Test your LLM-powered app against a local mock that **speaks the real provider APIs**. Your code keeps using the official SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`); you only change the base URL, or just set env vars. You get deterministic responses, scripted tool-call loops and a catalog of faults and awkward outputs. No tokens are spent.

> mock-llm tests how **your application handles** LLM responses: parsing, retries, tool loops, error paths, rendering. It does not measure model quality; that's what evals are for.

## The bug it catches

Your app asks for JSON with `max_tokens: 300`. Every test passes, and it ships. Then a long invoice comes in, the model
stops mid-object, and the API returns `finish_reason: "length"` with half a JSON document:

```ts
// src/invoice.ts
const r = await openai.chat.completions.create({ model: 'gpt-4o', max_tokens: 300, response_format: { type: 'json_object' }, messages });
return JSON.parse(r.choices[0].message.content!);
```

With mock-llm, that reply takes one line to script, and it reaches your code through the real OpenAI SDK:

```ts
// test/invoice.test.ts
import { edge } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';

const mock = useMockLLM();

test('tells the user when the model runs out of tokens mid-JSON', async () => {
  const openai = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test' });
  mock.when({}).reply(edge.truncated('{"customer": "Acme Ltd", "total": 1250.00, "lines": [{"sku": "A-1"'));

  await expect(extractInvoice(openai, 'INV-0042 …')).rejects.toThrow(/cut off/);
});
```

```text
 FAIL  test/invoice.test.ts > tells the user when the model runs out of tokens mid-JSON
AssertionError: expected [Function] to throw error matching /cut off/ but got 'Unexpected end of JSON input'
```

The fix is to check `choice.finish_reason === 'length'` before parsing, and now a test guards it. The same rule works
unchanged against Anthropic (`stop_reason: "max_tokens"`), the Responses API (`status: "incomplete"`), Gemini
(`MAX_TOKENS`) and Bedrock, because the mock answers in each provider's native format.

### What else it catches

| Your app… | Script it with | Docs |
|---|---|---|
| gives up on the first 429, or retries forever | `faults.rateLimit({ retryAfter: 2 })`. A native 429, so the SDK runs its real retry logic | [Faults](docs/failures.md#faults-negative-testing) |
| shows half an answer as complete when the stream drops | `faults.streamCut({ afterChunks: 5 })`, `faults.streamError()` | [Faults](docs/failures.md#faults-negative-testing) |
| crashes on broken tool-call JSON, or a tool that doesn't exist | `edge.malformedToolArgs('get_weather')`, `edge.hallucinatedTool()` | [Awkward outputs](docs/failures.md#awkward-outputs-edge-cases) |
| renders `<script>` from the model, or mangles emoji and RTL text | `edge.promptInjection()`, `edge.unicode()` | [Awkward outputs](docs/failures.md#awkward-outputs-edge-cases) |
| never sends the tool result back, or runs tools in the wrong order | `toHaveReturnedToolResult(…)`, `toHaveToolTrajectory([…])` | [Matchers](docs/assertions.md#asserting-on-what-your-app-sent) |
| makes an LLM call nobody planned, then swallows the error | strict mode: the test fails and prints the request, with a ready-made `mock.when(…)` | [Strict mode](docs/assertions.md#strict-mode) |
| sends the wrong system prompt or model, or costs too much | `toHaveReceivedRequest({ … })`, `toCostLessThan(0.05)` | [Matchers](docs/assertions.md#asserting-on-what-your-app-sent) |
| falls over when the prompt outgrows the context window | `contextWindow: { 'gpt-4o': 128_000 }` gives the native error | [Context window](docs/failures.md#context-window) |
| breaks when a model is retired, or rejects a thinking setting | `models: [{ id, lifecycle: 'retired' }]`, `capabilities` per model (Claude API 2026-10-21) | [Model errors](docs/failures.md#model-lifecycle-and-thinking-errors-claude) |
| fails only sometimes | seeded `chaos: { rate: 0.1 }`, replayed exactly with `MOCK_LLM_SEED` | [Chaos](docs/failures.md#chaos-errors-and-bad-content) |

**[Docs & live playground →](https://andrewfooteqa.github.io/mock-llm/)** Step-by-step lessons with real SDK runs, a free-form playground and the API reference.

[![A tutorial lesson: a tool-calling agent loop run through the OpenAI SDK against mock-llm](https://andrewfooteqa.github.io/mock-llm/screenshot.png)](https://andrewfooteqa.github.io/mock-llm/#/lesson/agent-loop)

## Install

```sh
npm install --save-dev mock-llm
```

- **Node ≥ 22.** ESM only (`import`, not `require`; a CommonJS build is planned: ROADMAP R14).
- **No runtime dependencies.** The mock speaks the wire protocols itself. Your app keeps its own provider SDKs.
- **Optional peers**, needed only for the feature that uses each: `yaml` (YAML scenario files), `vitest`
  (`mock-llm/vitest`), `@jest/globals` (`mock-llm/jest`), `@playwright/test` (`mock-llm/playwright`).
- **Versions:** 0.x, so a minor release may change APIs; see [`CHANGELOG.md`](CHANGELOG.md). Pin `~0.2.0` for patches
  only, or try pre-releases with `npm i -D mock-llm@next`. Releases are published by CI with npm provenance
  ([`RELEASING.md`](RELEASING.md)). Supported SDK versions are [tested](#compatibility).

## Quick start

```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createMockLLM } from 'mock-llm';

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
the adapter also registers the [matchers](docs/assertions.md#asserting-on-what-your-app-sent):

```ts
import { useMockLLM } from 'mock-llm/vitest'; // or 'mock-llm/jest'
const mock = useMockLLM({ strict: true });
```

For apps you don't construct directly, `mock.env()` returns base-URL env vars for every SDK, so you can test a whole
service, a CLI or Claude Code itself. Jest's ESM setup, Playwright and every option are in **[Setup](docs/setup.md)**.

## Documentation

| Guide | Covers |
|---|---|
| [Setup](docs/setup.md) | [Jest](docs/setup.md#jest) (ESM), [Playwright](docs/setup.md#playwright), [env vars](docs/setup.md#apps-you-dont-construct-directly-env-vars) for services and CLIs, [all options](docs/setup.md#options) |
| [Scripting responses](docs/scripting.md) | [Matchers and precedence](docs/scripting.md#scripting-responses), [tool loops](docs/scripting.md#agent--tool-loops), [exact stream chunks](docs/scripting.md#exact-stream-chunks), [latency](docs/scripting.md#latency), [YAML scenario files](docs/scripting.md#scenario-files-yaml--json), [per-request scenarios](docs/scripting.md#per-request-scenarios-no-code-changes), [provider notes](docs/scripting.md#provider-specific-notes) |
| [Failures](docs/failures.md) | [Faults](docs/failures.md#faults-negative-testing), [chaos](docs/failures.md#chaos-errors-and-bad-content), [reproducing a run](docs/failures.md#reproducing-a-run-mock_llm_seed), [context window](docs/failures.md#context-window), [awkward outputs](docs/failures.md#awkward-outputs-edge-cases) |
| [Assertions](docs/assertions.md) | [Matchers](docs/assertions.md#asserting-on-what-your-app-sent), [strict mode](docs/assertions.md#strict-mode), [the journal](docs/assertions.md#assertions-the-journal), [events](docs/assertions.md#events), [simulated cost](docs/assertions.md#simulated-cost) |
| [Live playground](https://andrewfooteqa.github.io/mock-llm/) | 18 runnable lessons, a free-form scenario editor and the API reference, replaying runs recorded against the real SDKs, rebuilt for every release. Run it locally with `npm run playground` (http://localhost:4317) to try your own input. |

## Supported APIs

| Provider API | Endpoints |
|---|---|
| **OpenAI**: Chat Completions, Responses API (incl. `previous_response_id`), embeddings, models. Also any OpenAI-compatible API: xAI Grok, Mistral, Groq, DeepSeek, Ollama, vLLM… | `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models` |
| **Anthropic** Messages, count_tokens, models. Also Claude Code and the Claude Agent SDK | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| **Google Gemini**: generateContent / streamGenerateContent, countTokens, embedContent (Vertex `:predict` too), models. AI Studio and Vertex URL forms | `/v1beta/models/{m}:generateContent` … |
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

## Compatibility

Supported versions are tested, not assumed. A [compatibility matrix](scripts/compat.mjs) runs the library's tests with
each provider SDK at its **oldest supported and latest release**, the example projects with each test framework at both
ends of its range, and type-checks the published `.d.ts` files with the oldest and newest TypeScript. It runs weekly, on
every dependency update, and as a smoke subset on every pull request. The table is generated from its last results:

<!-- compat:start (generated by `node scripts/compat.mjs readme`; do not edit by hand) -->

| Package | Supported | Oldest, tested | Latest, tested |
|---|---|---|---|
| `openai` | `>=6.0.0` | ✅ 6.0.0 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 7.53.0 <sub>(Node 24 · 2026-11-09)</sub> |
| `@anthropic-ai/sdk` | `>=0.66.0` | ✅ 0.66.0 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 1.6.0 <sub>(Node 24 · 2026-11-09)</sub> |
| `@google/genai` | `>=1.6.0` | ✅ 1.6.0 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 3.0.0 <sub>(Node 24 · 2026-11-09)</sub> |
| `@aws-sdk/client-bedrock-runtime` | `>=3.906.0` | ✅ 3.906.0 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 3.1164.0 <sub>(Node 24 · 2026-11-09)</sub> |
| `vitest` | `>=4.0.1` | ✅ 4.0.1 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 5.1.0 <sub>(Node 24 · 2026-11-09)</sub> |
| `jest` + `@jest/globals` | `>=29.0.0` | ✅ 29.0.0 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 30.5.2 <sub>(Node 22, 24 · 2026-11-09)</sub> |
| `@playwright/test` | `>=1.56.0` | ✅ 1.56.0 <sub>(Node 22, 24 · 2026-11-09)</sub> | ✅ 1.65.0 <sub>(Node 24 · 2026-11-09)</sub> |
| `yaml` | `>=2.0.0` | ✅ 2.0.0 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 2.9.1 <sub>(Node 24, 26 · 2026-11-09)</sub> |
| `typescript` | `>=6.0.2` | ✅ 6.0.2 <sub>(Node 24, 26 · 2026-11-09)</sub> | ✅ 7.0.2 <sub>(Node 24, 26 · 2026-11-09)</sub> |

<!-- compat:end -->

How floors are chosen, and how SDK updates are handled, is in
[`RELEASING.md` › Compatibility policy](RELEASING.md#compatibility-policy) and the
[SDK update playbook](CLAUDE.md#sdk-updates-dependency-prs). Provider SDKs are your app's dependencies, so mock-llm
doesn't declare them; Vitest, Jest, Playwright and `yaml` are optional peers with ranges matching the tested floors.
Node: every even-numbered line until end of life.

## Example projects

[`examples/`](examples) has standalone starter projects, one per provider plus RAG, an end-to-end service and Claude Code.
Each pairs real app code with a test suite, and the TypeScript ones type-check against the published types (`strict`).
Run them all with `npm run test:examples`. `npm run coverage:examples` reports which library features they use, and
`npm run check` fails when a feature has no example and no recorded exemption.

| Example | Also shows |
|---|---|
| [`openai-support-bot`](examples/openai-support-bot) | Every fault, retries counted from the journal, awkward outputs, strict mode, a shared YAML baseline across tests, an expectation step failing for the checked reason, chaos |
| [`claude-tool-agent`](examples/claude-tool-agent) | `messages.stream()` incl. streamed tool turns, `{ thinking }`, tool matchers, routing on conversation shape, quick mode (`speed` matcher, `between_tools` progress updates, model `capabilities` / `lifecycle` via `models`) |
| [`gemini-structured-extraction`](examples/gemini-structured-extraction) | Schema output and violations, `generateContentStream` + mid-stream error, Vertex AI, `fakeFromSchema` |
| [`bedrock-streaming-summarizer`](examples/bedrock-streaming-summarizer) | Converse / ConverseStream / InvokeModel (+ stream), events incl. `fault`, the `wire` record, latency |
| [`node-service-e2e`](examples/node-service-e2e) | `node:test`, `mock.env()`, YAML QA scenarios, forwarded `x-mock-scenario`, a sweep of every built-in scenario |
| [`jest-travel-assistant`](examples/jest-travel-assistant) | **Jest** (ESM), OpenAI Responses API tool loop, `responses.stream()`, memory, strict mode, matchers |
| [`playwright-chat-ui`](examples/playwright-chat-ui) | **Playwright** full-stack: server + browser-direct calls, `routeBrowser`, real-provider guard, strict mode, async matchers, mid-stream UI via exact chunks |
| [`rag-knowledge-base`](examples/rag-knowledge-base) | Embeddings on every provider (incl. Vertex), token counting, `models.list`, cost with custom pricing |
| [`claude-code-cli`](examples/claude-code-cli) | The real Claude Code CLI against the mock, asserting on what it sent |

The full feature list per example is in [`examples/README.md`](examples/README.md).

## Development

```sh
npm install
npm test                  # unit + contract tests (official SDKs against the mock)
npm run playground:check  # every tutorial lesson × variant × provider
npm run test:examples     # every example project, against a fresh build (Playwright example: run `npx playwright install chromium` once;
                          # claude-code-cli skips (⊘) without the `claude` CLI)
npm run coverage:examples # which library features the examples use; fails on a feature with no example or exemption
npm run check             # all of the above + typecheck
```

Contributing and releasing: see [`CONTRIBUTING.md`](CONTRIBUTING.md) (every PR that changes the package adds a changeset) and [`RELEASING.md`](RELEASING.md).

Planned work and its acceptance criteria live in [`ROADMAP.md`](ROADMAP.md); each item is signed off before the next starts. Every change ships with tests, updated docs and tutorial, and updated examples. See [`CLAUDE.md`](CLAUDE.md) for the full definition of done. When working with Claude Code, a project Stop hook (`.claude/settings.json`) enforces it by running `npm run check` before Claude finishes.

Adding a provider means implementing the `Adapter` interface in `src/providers/adapter.ts` (parse → IR, render IR → wire format, native errors) and adding contract tests that use that provider's official SDK.

## License

MIT
