# mock-llm roadmap

mock-llm is a **library used inside test frameworks** (Vitest, Jest, Playwright, node:test). It controls what the
model does and records what the app sent. It is **not** a test runner, a reporter or an eval tool. Every item below is
judged against that line.

## How this roadmap works (sign-off workflow)

Each item moves through these statuses:

```
Proposed → In progress → Ready for sign-off → Signed off
                ↑                │
                └── Changes requested
```

1. **One item at a time.** Only one item is `In progress`, taken in roadmap order unless the maintainer reorders.
2. **Agree the criteria first.** Before starting, restate the item's acceptance criteria. The maintainer may amend
   them; amendments are recorded under the item.
3. **Tick with evidence only.** A criterion is ticked only with evidence: a test name, command output, a lesson or
   example path. Write the evidence next to the tick.
4. **Standard criteria apply to every item** (from CLAUDE.md's definition of done):
   - tests (unit, plus contract tests through the official SDKs for anything on the wire)
   - README + playground lesson and/or Reference updated
   - example project updated or added where it helps someone get started
   - `npm run check` green
5. **Stop at `Ready for sign-off`.** Post a sign-off summary listing each criterion with its evidence, plus anything
   deferred or descoped and why. Then stop.
6. **Only the maintainer signs off.** On "signed off", record `Signed off: <date>` and only then start the next item.
   On "changes requested", record the requested changes under the item and go back to `In progress`.
7. **No silent scope creep.** New ideas or gaps found mid-item become new roadmap items or recorded amendments, never
   unplanned additions to the current item.

Item template:

```markdown
### Rn. Title (ideas #…)
**Status:** Proposed
**Goal:** one sentence.
**Acceptance criteria**
- [ ] criterion (evidence: …)
- [ ] Standard criteria: tests · docs/lesson · example · `npm run check`
**Amendments:** none
```

---

## Shipped (baseline, before this roadmap)

**Status:** Shipped (baseline). Verified by `npm run check` at the time of writing. Not re-signed-off unless requested.

- Provider adapters with native wire formats, streaming and errors: OpenAI Chat Completions + Responses API,
  Anthropic Messages, Google Gemini (AI Studio + Vertex paths), AWS Bedrock (Converse/Invoke, binary event stream,
  HTTP/1.1 + HTTP/2)
- Rule engine (matchers, latest-rule-wins, `once`/`times`, sequences), responders (text, template, echo, lorem, JSON,
  tool calls, schema-generated output/args, thinking), `inject`
- Faults (`faults.*`), edge cases (`edge.*`), built-in and custom per-request scenarios (header / `[[mock:…]]`), error-only chaos
- Scenario files (YAML/JSON, validated), journal with wire recording, usage and cost estimates (verified Claude prices)
- `mock-llm/vitest` lifecycle helper, `mock.env()`, `/__mock/journal` + `/__mock/reset`
- Playground docs site + `playground:check`; 6 example projects + `test:examples`; CLAUDE.md + Stop hook

## Out of scope

Recorded so they are not re-proposed. Revisit only by explicit maintainer decision.

| Idea | Why it's out |
|---|---|
| Assertions on app output (`toHaveText`, `toContainText`, `toMatchSchema`, `toBeValidJSON`) | General-purpose assertions; `expect`, zod and ajv already do this |
| Semantic / criteria assertions (`toBeSemanticallySimilarTo`, `toSatisfyCriteria`) | That's LLM-as-judge, i.e. evals: non-deterministic and costs tokens |
| `toHandleGracefully()` | "Graceful" is app-specific; tests should assert the app's actual behaviour |
| Test-runner features: running suites, `--seed` CLI flags, retries, mutation-score runs (`mock-llm mutate`) | Runner territory (the seed is supported via env var, R7e) |
| CLI / HTML test reports (`mock-llm report`) | Reporting belongs to the framework; we expose data instead (R12) |
| Production capture / instrumentation, OpenTelemetry exporters | Observability tooling; we emit events (R4) and accept fixtures (R9) |
| `mock.setProvider()` | The app's SDK chooses the provider; parametrize the suite across providers instead |

---

## Phase V1.5: "Inside your test framework"

### R1. Scope statement in README
**Status:** Signed off: 2026-10-04
**Goal:** make the library/not-a-framework boundary visible to users and contributors.
**Acceptance criteria**
- [x] README has a "Scope: what mock-llm is not" section matching the Out of scope table above
  (evidence: `README.md` § "Scope: what mock-llm is not", placed before Quick start. Same 7 rows as this table, counted
  programmatically: 7 = 7, with a "Use instead" column added for users; links back here)
- [x] Playground Reference page links to the scope section
  (evidence: Reference page has a first "Scope" section and TOC entry linking to `/docs/README.md#scope-what-mock-llm-is-not`.
  Verified in Chrome: link fetch → 200 and contains the heading; screenshot checked)
- [x] Standard criteria: no tests needed (docs only) · docs · `npm run check`
  (evidence: `npm run check` exit 0: 72 library tests, 225 lesson runs / 0 failures, 6/6 examples)
**Amendments:** to make the Reference link resolve locally, the playground server now serves `README.md` and
`ROADMAP.md` read-only at `/docs/<name>.md` (exact-match allowlist; `/docs/package.json`, `/docs/CLAUDE.md` and
traversal attempts → 404). Accepted by the maintainer at sign-off.

### R2. Request matchers: framework-agnostic core + Vitest (ideas #2, #3, #17)
**Status:** Signed off: 2026-10-04
**Goal:** assert on what the app *sent* to the model, with AI-aware matchers.
**Acceptance criteria**
- [x] `src/assert/` contains pure functions over `Journal` returning `{ pass, message, expected, actual }`, with no test-framework imports in core
  (evidence: `src/assert/index.ts` imports only `../core/*`; exported from `mock-llm`; used without a framework in `examples/node-service-e2e` via `node:test`)
- [x] Tool matchers with distinct semantics: offered / requested (mock → app) / returned (app → mock) / trajectory (exact | subsequence)
  (evidence: `tests/unit/assertions.test.ts` › "tool matchers"; trajectory also supports `source: 'requested'` and `{ name, args }` steps)
- [x] Call matchers (**renamed, see A1**): `toHaveReceivedRequest(expected?)`, `toHaveReceivedRequestTimes(n)`, `toHaveReceivedPrompt(text | RegExp | asymmetric, { in })`
  (evidence: `tests/unit/assertions.test.ts` › toHaveReceivedRequest / toHaveReceivedRequestTimes / toHaveReceivedPrompt)
- [x] Budget matchers: `toHaveUsedTokensLessThan(n, { kind })`, `toCostLessThan(usd, { allowUnpriced })`
  (evidence: `tests/unit/assertions.test.ts` › "budget matchers"; `tests/contract/assertions.test.ts` › "toCostLessThan works for Claude")
- [x] Every matcher accepts a filter (provider / model / endpoint; chat-only by default)
  (evidence: filter cases in `tests/unit/assertions.test.ts`, e.g. `{ endpoint: 'any' }`, `{ provider: 'openai' }`, `toCostLessThan(…, { filter })`)
- [x] Failure messages include a journal excerpt (system, last user message, tools offered, tool results sent, mock reply)
  (evidence: message assertions in `tests/unit/assertions.test.ts`; seen live in the playground lesson "A failing assertion" variant)
- [x] `mock-llm/vitest` registers the matchers with TypeScript types
  (evidence: `declare module 'vitest' { interface Matchers }` in `src/testing/vitest.ts`; `@ts-expect-error` probe in the unit test passes `npm run typecheck`;
  `examples/claude-tool-agent` type-checks against the **packed** package (tsc exit 0) and a `@ts-expect-error` probe there proves the types are active)
- [x] Unit tests cover pass **and** fail messages for every matcher; a contract test uses them through real SDKs
  (evidence: `tests/unit/assertions.test.ts`: 18 tests; `tests/contract/assertions.test.ts`: the same agent loop through all 5 SDK paths
  (OpenAI Chat, Responses, Anthropic, Gemini, Bedrock) + Claude cost: 6 tests)
- [x] Standard criteria
  (evidence: README § "Asserting on what your app sent"; playground lesson `assertions` (live, evaluated with the real core,
  3 variants incl. a deliberate failure) + Reference § Assertions; 5 examples migrated (`openai-support-bot`, `claude-tool-agent`,
  `gemini-structured-extraction`, `bedrock-streaming-summarizer`, `node-service-e2e`); `npm run check` exit 0: 96 library tests,
  240 lesson runs / 0 failures, 6/6 examples)
**Amendments** (A1–A4 accepted by the maintainer at sign-off):
- **A1. Renamed call matchers.** `toHaveBeenCalled`, `toHaveBeenCalledTimes` and `toHaveBeenCalledWith` are built-in spy matchers in Vitest
  *and* Jest. Registering them would replace them globally and break users' `expect(spy).toHaveBeenCalled()`. They became
  `toHaveReceivedRequest()` (≈ toHaveBeenCalled), `toHaveReceivedRequest({...})` (≈ toHaveBeenCalledWith) and `toHaveReceivedRequestTimes(n)`.
  A unit test proves the built-in spy matchers still work.
- **A2. Trajectory default.** `toHaveToolTrajectory` defaults to the tools the app **ran** (sent results for), with `source: 'requested'` for
  the tools the mock asked for. Only results after a request's last assistant message count, so history isn't double counted.
- **A3. Playground support.** Lessons can declare `assertions` (evaluated server-side with the real core), with a new Assertions tab and
  `expectAssertionFailure` verified by `playground:check`.
- **A4. `Journal.all()` / `cost()`** also accept a predicate function (needed for filtered cost).

### R3. Strict mode (idea #21)
**Status:** Signed off: 2026-10-04
**Goal:** an unexpected LLM request fails the *test*, even when the app swallows the error.
**Acceptance criteria**
- [x] `createMockLLM({ strict: true })`: unmatched chat requests receive a native error **and** are recorded as `unmatched` in the journal
  (evidence: `tests/unit/strict.test.ts` › "gives unmatched chat requests a native, non-retried 400 and flags them" (OpenAI `BadRequestError`,
  exactly one request despite `maxRetries: 2`) and "uses each provider's native error type (Anthropic)"; the playground lesson `strict`
  "Unscripted request" variant gets the native 400 on all 5 provider paths in `playground:check`)
- [x] `mock.assertNoUnmatched()` throws an "UNEXPECTED LLM REQUEST" message with provider, model, last user message, tools offered, and a suggested `mock.when(...)`
  (evidence: `tests/unit/strict.test.ts` › "lists provider, model, prompt, tools and a suggested rule per request"; also suggests
  `hasToolResult: true` for agent-loop continuations › "suggests hasToolResult …"; throws `UnmatchedRequestError`)
- [x] `useMockLLM({ strict: true })` (Vitest) fails the test in `afterEach`, proven by a test whose app code catches and ignores the error
  (evidence: `tests/unit/strict.test.ts` › "fails a test whose app swallowed the error, and passes a scripted one" runs
  `tests/fixtures/strict/swallow.fixture.ts` in a child Vitest process; the JSON report shows the swallowing test **failed** with
  "UNEXPECTED LLM REQUEST" and the scripted test **passed**)
- [x] Non-chat endpoints (models, count_tokens, embeddings) never count as unmatched
  (evidence: `tests/unit/strict.test.ts` › "never counts non-chat endpoints" through the real OpenAI and Anthropic SDKs)
- [x] `expect(mock).toHaveNoUnmatchedRequests()` matcher (core + Vitest, supports `.not` and filters) *(amendment A1)*
  (evidence: `tests/unit/strict.test.ts` › "passes, fails with the report, supports .not and filters"; typed in `MockLLMMatchers`)
- [x] Standard criteria: tests · README + playground lesson · example · `npm run check`
  (evidence: README § "Strict mode" + matcher row + option; playground lesson `strict` (3 variants, live assertions) + Reference rows;
  `examples/openai-support-bot` runs with `strict: true` and demonstrates the bot hiding an error that strict mode catches;
  `npm run check` exit 0: 106 library tests, 255 lesson runs / 0 failures, 6/6 examples)
**Amendments:**
- A1 (agreed before starting, 2026-10-04): add a `toHaveNoUnmatchedRequests()` matcher alongside `assertNoUnmatched()`.
- A2 (decided during implementation, accepted by the maintainer at sign-off):
  - The strict error is a **400** (`bad_request`), because SDKs never retry 400s, so one surprise request means one journal entry.
  - Unmatched requests are flagged even **without** `strict`, so `assertNoUnmatched()` and the matcher work in non-strict suites.
    `strict` adds the error response and the automatic `afterEach` failure.
  - A chaos-injected fault counts as unmatched if no rule or `default()` would have matched the request.
  - `onUnmatched: 'error'` is kept (400 without failing the test) for backwards compatibility.
**Post-sign-off fix** (2026-10-04, found during R5): the test "chaos faults still count as unmatched…" was **flaky** (it failed 3 of 4 runs
in isolation). It depended on the OpenAI SDK's randomized exponential backoff for a 500, which often exceeded Vitest's 5 s timeout, and
passed at R3 sign-off by chance. Fixed by giving the fault `retryAfter: 0` (immediate, deterministic retries, still 3 real requests).
Verified 10/10 passes in ~0.7 s. No behaviour change in the library.

### R4. Event hooks (idea #27)
**Status:** Signed off: 2026-10-04
**Goal:** let users and integrations observe mock activity without polling the journal.
**Acceptance criteria**
- [x] `mock.on` / `mock.off` for `request`, `response`, `fault`, `chunk`, `unmatched`, with typed payloads (journal entry; chunk text or bytes)
  (evidence: `MockLLMEvents` / `MockLLMEventName` exported from `mock-llm`; `tests/unit/events.test.ts`: 13 tests incl. payload checks for
  each event, Bedrock chunk `data` as `Uint8Array` with decoded `text` (A1), and `off()` removal)
- [x] A throwing listener never breaks the mock's response; the error is surfaced via `console.error`
  (evidence: `tests/unit/events.test.ts` › "a throwing listener never breaks the response…" (sync throw in `request` and `chunk`, both
  non-streaming and streaming) and "a rejecting async listener is reported, not unhandled")
- [x] Event ordering is guaranteed and tested: `request → chunk* → response | fault`
  (evidence: an `assertOrdering()` invariant `request (unmatched)? chunk* (response|fault)` in `tests/unit/events.test.ts` across plain, SSE and
  Bedrock binary streaming, error/stream-cut/stream-error/timeout faults, strict unmatched, validation errors and non-chat endpoints.
  The same invariant is enforced by `playground:check` for every request in all 255 lesson runs across 5 providers)
- [x] Standard criteria: tests · Reference + lesson section · `npm run check`
  (evidence: README § Events; Reference § Events; the "Assertions, journal & cost" lesson has an events section plus a live **Events** tab on every
  run; `examples/bedrock-streaming-summarizer` adds an events test; `npm run check` exit 0: 119 library tests, 255 lesson runs / 0 failures, 6/6 examples)
**Amendments:**
- A1 (agreed when starting, 2026-10-04): `chunk` payloads carry both the raw `data` (string or bytes) and readable `text`; Bedrock's binary event-stream frames are decoded to text (as in the wire log).
- A2 (decided during implementation, accepted by the maintainer at sign-off):
  - **Exactly one terminal event per request.** `fault` when an injected fault ended it; otherwise `response`, at any status, including
    validation errors and strict-mode 400s. `request` (and `unmatched`) always come first, even when parsing fails.
  - **Terminal events fire when the exchange is over.** For a client timeout, that's when the client hangs up, so a test may need to wait
    for it. The playground demo server waits for in-flight exchanges before reporting (found by `playground:check`); no library API was added for this.
  - **The error frame is a chunk.** For `faults.streamError`, the native error frame is emitted as the last `chunk` before `fault`, matching the wire log.
  - **Listeners survive `reset()`.** They're integration-level, unlike rules.
  - **Shared decoding.** `chunk` text and the wire log use one shared decoder (`chunkText`).
**Changes requested** (2026-10-04, maintainer): the example indexes (`examples/README.md`, root README "Example projects",
Reference page example table) don't mention events, nor the R2 matchers / R3 strict mode the examples now use. Update all three, and add a
CLAUDE.md rule that example index rows are updated whenever an example gains a feature.
**Resolution** (2026-10-04): rows rewritten from a grep of what each example's tests actually use. All three indexes now cover events
(`bedrock-streaming-summarizer`), the R2 matchers (5 examples) and R3 strict mode (`openai-support-bot`). The root README list became a table.
CLAUDE.md now has a "keep the three example indexes in sync" rule. The Reference rows render correctly (checked in Chrome).
`npm run check` exit 0: 119 library tests, 255 lesson runs / 0 failures, 6/6 examples. Also fixes the R2/R3 index staleness (docs-only).

### R5. Jest adapter (idea #22)
**Status:** Signed off: 2026-10-04
**Goal:** the same lifecycle helper and matchers for Jest users.
**Acceptance criteria**
- [x] `mock-llm/jest` exports `useMockLLM()` and registers the R2 matchers via `expect.extend`, with typings
  (evidence: `src/testing/jest.ts` (export `./jest` in package.json); shared `src/testing/matchers.ts` used by both adapters.
  `tests/unit/jest-adapter.test.ts` builds `dist/` and runs **Jest 30 in ESM mode** on `tests/fixtures/jest/`: matchers pass, negate and fail with
  the excerpt; Jest's built-in spy matchers still work; `useMockLLM({ strict: true })` fails exactly the test whose app swallowed the error.
  Typings verified against the example's installed packed package for both `expect` from `@jest/globals` and the global `expect` from
  `@types/jest` (tsc exit 0; `@ts-expect-error` probes consumed, so the types are active))
- [x] An example project runs under Jest
  (evidence: new `examples/jest-travel-assistant`, an OpenAI **Responses API** assistant with a tool loop via `previous_response_id`, memory,
  strict mode, and 6 Jest tests passing in `test:examples`)
- [x] Jest is an optional peer dependency; importing `mock-llm` alone never requires it
  (evidence: `@jest/globals` is an optional peer in package.json; `tests/unit/jest-adapter.test.ts` › "importing 'mock-llm' never loads jest or
  vitest" walks dist/index.js's static **and** dynamic import graph: static bare imports are `node:` built-ins only, the only lazy one is `yaml`)
- [x] Standard criteria: tests · docs · example · `npm run check`
  (evidence: README § Jest (ESM setup), Quick start and matchers notes; Reference install snippet and assertions intro; assertions lesson
  mentions `mock-llm/jest`; the new example is in all three example indexes; CLAUDE.md layout; `npm run check` exit 0: 121 library tests,
  255 lesson runs / 0 failures, 7/7 examples)
**Amendments:**
- A1 (agreed before starting, 2026-10-04): mock-llm stays ESM-only for R5. The Jest ESM setup (`--experimental-vm-modules`) is documented and proven by the example. A CommonJS build is tracked separately as R14.
- A2 (decided during implementation, accepted by the maintainer at sign-off):
  - Matcher wrapping and types moved into a shared, framework-free `src/testing/matchers.ts`. The Vitest adapter re-exports the same API
    (no change for users).
  - The Jest adapter tests run against the **built** `dist/`, since Jest can't load our TS sources; the test builds first.
  - TypeScript-with-Jest guidance is general ("keep your ESM transform"); no specific ts-jest/babel/swc config is claimed, as none was verified.
  - `jest` and `@jest/globals` were added as root **devDependencies**, for tests only.

### R6. Playwright integration (ideas #24, #25)
**Status:** Signed off: 2026-10-04
**Goal:** full-stack browser tests that control the AI environment.
**Acceptance criteria**
- [x] `mock-llm/playwright` provides an `llm` fixture (control client) and a documented setup that gets `mock.env()` to the app *(see A3 for startup order)*
  (evidence: `src/testing/playwright.ts`: `test` (fixtures `llm`, `llmStrict`, `blockRealProviders`), `expect`, `startMockLLM` for globalSetup,
  `mockLLMEnv(port)` for `webServer.env`. `examples/playwright-chat-ui` runs it in **Chromium**: 7 tests, `test:examples` ✔)
- [x] HTTP control API extended: load scenario, reset, journal, assert-no-unmatched; R2 matchers work on the remote client *(summary dropped, A1)*
  (evidence: `GET /__mock/info`, `GET /__mock/journal`, `POST /__mock/reset`, `POST /__mock/load` in `src/mock.ts`; `RemoteMockLLM` + `remoteAssertions`
  in `src/remote.ts`; `tests/unit/remote.test.ts`: 13 tests (load/info/journal snapshot priced with the remote table/reset, 400 on an invalid scenario
  with the validation message, 404 on an unknown endpoint, unreachable-mock error, remote matchers + failure messages, remote `assertNoUnmatched`,
  `urlsFor`/`envFor`). In the browser example, `await expect(llm).toHaveToolTrajectory/…` passes)
- [x] `llm.routeBrowser(page)` intercepts browser-direct calls to provider hosts
  (evidence: example › "routeBrowser sends the browser call to the mock" (a BYOK fetch to api.openai.com answered by the mock, with CORS preflight
  handled); `providerRewrite` unit-tested for OpenAI, xAI, Anthropic, Gemini (incl. query string) and Bedrock hosts; non-provider URLs untouched)
- [x] `blockRealProviders` guard: any request to a real provider host fails the test loudly
  (evidence: auto fixture, on by default. Example › "without routeBrowser, a real provider call fails the test" (`test.fail`), and
  `tests/check-expected-failures.mjs` verifies its **only** error is "REAL LLM PROVIDER REQUEST BLOCKED…". Scope: browser traffic, see A4)
- [x] Parallel-worker limitation documented, with recipes
  (evidence: README › Playwright › Parallel workers (`workers: 1`, which the example uses); the fixture warns when `workers > 1`.
  The "per-test key header" recipe isn't implemented, see A5 / R15)
- [x] New `examples/playwright-chat-ui` (tiny server + page) passes in `test:examples`
  (evidence: 7 tests: tool loop, outage (SDK retry), streaming, prompt-injection rendering, routeBrowser, guard and strict deliberate failures;
  `posttest` reason check ✔✔; `test:examples` 8/8)
- [x] Standard criteria: tests · docs + lesson · example · `npm run check`
  (evidence: README § Playwright (+ Parallel workers), control API in the journal section and Reference; new lesson `playwright`; all three example
  indexes; CLAUDE.md layout; `npm run check` exit 0: 134 library tests, 255 lesson runs / 0 failures, 8/8 examples)
**Amendments:**
- A1 (agreed before starting, 2026-10-04): "summary" dropped from the control API; `mock.summary()` stays in R12.
- A2 (agreed before starting, 2026-10-04): maintainer approved installing `@playwright/test` and downloading Chromium (`npx playwright install chromium`) for tests.
- A3–A6 (decided during implementation, accepted by the maintainer at sign-off):
  - **A3. Startup order.** Verified in Playwright 1.63's runner source: `webServer` (a plugin) starts **before** `globalSetup`, so "start the mock
    before webServer" isn't possible with globalSetup. Instead, `mockLLMEnv(port)` computes the app's env from a fixed port (no running mock needed),
    and `startMockLLM` starts the mock in globalSetup. This works whenever the app only calls the LLM while handling requests. Apps that call the LLM
    while booting would need a launcher run as a `webServer` entry, now part of R15.
  - **A4. Guard scope.** `blockRealProviders` covers **browser** traffic (Playwright can only route the browser). Server-side calls are pointed at the
    mock by `mockLLMEnv`; intercepting hardcoded hosts in Node is R13.
  - **A5. Per-test key header recipe** not implemented (it needs namespaced rules and journals in the mock). Documented as a limitation with the
    working `workers: 1` recipe; added **R15** to V2.
  - **A6. Remote design.** Remote scripting uses the scenario-file format (function responders can't cross processes); remote matchers snapshot the
    journal and run the same core (`remoteAssertions`, also exported for non-Playwright use); added `urlsFor`/`envFor` (mock.env() now uses them).
    Routed browser responses are buffered by Playwright (streams arrive at once), documented. The example's `posttest` verifies deliberate failures
    fail for the right reason, after a first run showed a `test.fail` could pass via a timeout.

### R7. Engine gaps
Each sub-item is a separate sign-off. Standard criteria apply to each.

#### R7a. Per-step / per-rule latency and distributions (ideas #5, #7)
**Status:** Signed off: 2026-10-04
- [x] `reply(…, { delay })` per step and `.latency({...})` per rule, overriding global latency
  (evidence: `tests/unit/latency.test.ts` › "records the applied latency and the response never arrives early" (global 30 → rule 60 → step 90),
  "sequence steps can each have their own delay", "rule tokensPerSec overrides the global streaming speed")
- [x] `{ min, max }` (uniform) and `{ distribution: 'normal', mean, stdDev }`, seeded and reproducible
  (evidence: › "fixed, uniform and normal delays" (bounds, normal mean ≈ 300 over 4000 samples, clamped at 0), "same seed → same delays; different
  seed → different delays", "reset() restarts the latency stream")
- [x] Supported in scenario files
  (evidence: › "supports rule latency and step delays in scenario files" (rule `latency:` + step `delay:`); located validation errors, e.g.
  `scenario: rules[0].steps[0]: invalid delay…`)
- [x] Deterministic timing tests (same seed → same delays)
  (evidence: timing asserted through the recorded `entry.latency`; wall-clock checks are lower bounds only. The suite passed 8/8 consecutive runs)
- [x] Standard criteria
  (evidence: README § Latency + options + scenario-file keys; Reference rows (`latency` option, `reply` `delay`, `.latency()`); streaming lesson
  gains variants "Per-step delays (slow agent)" and "Random latency (seeded)" (×5 providers in `playground:check`);
  `examples/bedrock-streaming-summarizer` adds a per-rule seeded-latency test; indexes updated; `npm run check` exit 0: 145 library tests,
  265 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- The global `latency.firstTokenMs` also accepts `{ min, max }` / normal (backwards compatible: numbers still work).
- Random delays use a **separate seeded stream** (derived from `seed`), so enabling latency doesn't change generated text or ids; `reset()` restarts it.
- The applied delay is recorded on each journal entry (`entry.latency = { firstTokenMs, tokensPerSec }`), which makes timing assertions deterministic.
- **Error faults stay immediate**, which is unchanged behaviour. Stream faults (`streamCut` / `streamError`) honour rule and global latency.
  `delay` on a `fail` step is rejected with a clear message (use rule-level `latency`).
- Invalid delays (`min > max`, negatives, unknown distributions) throw when the rule or option is defined, with scenario-file locations.

#### R7b. Explicit stream chunks (idea #8)
**Status:** Signed off: 2026-10-04
- [x] `reply({ chunks: [...] }, { chunkIntervalMs })` streams exactly the given chunk boundaries
  (evidence: `tests/contract/chunks.test.ts`: uneven, mid-word chunks incl. an emoji ZWJ sequence arrive as exactly those SDK deltas;
  `chunkIntervalMs` paces the stream (lower-bound timing) and is recorded in `entry.latency`; non-streaming gets the joined text)
- [x] Verified per provider stream format (OpenAI Chat, Responses, Anthropic, Gemini, Bedrock)
  (evidence: the same test through 6 official-SDK paths: OpenAI Chat, OpenAI Responses, Anthropic, Gemini, Bedrock ConverseStream, **and**
  Bedrock InvokeModelWithResponseStream (Claude body); refusals stream in the given chunks too (OpenAI refusal deltas). The suite passed 6/6 repeat runs)
- [x] Supported in scenario files
  (evidence: › "scenario files: reply: { chunks } with chunkIntervalMs, and clear validation" (located errors for empty/non-string chunks,
  negative interval, interval on `fail`))
- [x] Standard criteria
  (evidence: README § Exact stream chunks + scenario-file keys; Reference `reply` row; streaming lesson variant "Exact chunks" (×5 providers in
  `playground:check`); `examples/playwright-chat-ui` new test "renders partial text while the answer is still streaming" asserts the UI's
  **intermediate** state in Chromium (4/4 repeat runs); indexes updated; `npm run check` exit 0: 156 library tests, 270 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- Text blocks in the IR carry optional `chunks` (their concatenation is the `text`). All adapters stream them through one shared helper (`textPieces`),
  so full `IRResponse` objects can use them too, e.g. a chunked refusal.
- `chunkIntervalMs` pauses between **all** streamed events (text chunks plus protocol framing such as message start/stop), overriding `tokensPerSec`.
  This is documented.
- `inject()` keeps chunks consistent: a suffix becomes its own final chunk, a prefix joins the first chunk, and replace collapses to one chunk.
- Only answer text is chunk-controlled; thinking/reasoning text keeps the default word-sized pieces.

#### R7c. Model globs and `tools` matcher (idea #20)
**Status:** Signed off: 2026-10-04
- [x] `model: 'claude-*'` glob matching (alongside the existing substring and RegExp forms)
  (evidence: `tests/unit/model-tools-matchers.test.ts`: a 12-case table (whole-id anchoring, `*claude-*` for Bedrock ids, `?`, literal `.`,
  substring backwards compatibility) + RegExp; one rule per family routes real **OpenAI, Anthropic, Gemini and Bedrock** SDK requests)
- [x] `tools: ['a', 'b']` matches requests offering all listed tools
  (evidence: › "matches when every listed tool is offered, in any order, alongside others", "combines with other matchers (latest rule wins)";
  an empty or invalid list is rejected)
- [x] Supported in scenario files
  (evidence: › "works in scenario files, together with model globs"; located error `scenario: rules[0].when: invalid tools matcher…`)
- [x] Standard criteria
  (evidence: README matcher docs + glob examples; Reference rows; "Matching requests" lesson variants "Model globs (switch providers)" and
  "All of these tools offered". Each provider was verified to hit the intended rule, e.g. Bedrock → "Claude family rule matched
  us.anthropic.claude-sonnet-5-5". `examples/claude-tool-agent` adds a glob + tools routing test; indexes updated;
  `npm run check` exit 0: 175 library tests, 280 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- Globs apply only when a `model` string contains `*` or `?`, and match the **whole** id. Strings without wildcards keep substring matching
  (backwards compatible).
- An empty `tools: []` is rejected, pointing to `hasTools: false` for "no tools".
- For consistency, assertion filters (`filter: { model }`) use the same glob/substring/RegExp rules via a shared `matchModel`.
- **`playground:check` hardened:** it now fails if a lesson run makes an unscripted request. Verifying this variant showed a broken lesson rule
  would otherwise silently fall back to the canned reply and still "pass". Intentional cases are marked `allowUnmatched` (true, or a list of providers):
  structured output on Bedrock, and strict mode's "Unscripted request". Documented in CLAUDE.md.

#### R7d. Context window (idea #18)
**Status:** Signed off: 2026-10-04
- [x] `contextWindow: { [modelGlob]: tokens }` auto-returns the native context-length error when approximate input tokens exceed the limit
  (evidence: `tests/contract/context-window.test.ts`: per provider, small passes and oversized fails; exact id > longest glob precedence; non-wildcard
  keys exact-only; conversation history counts (Responses `previous_response_id`); invalid windows rejected at creation)
- [x] Token approximation documented next to the option
  (evidence: JSDoc on `MockLLMOptions.contextWindow`; README options block comment "tokens are APPROXIMATE (~4 chars/token, input only)";
  README § Context window "Approximate counting"; Reference `contextWindow` row)
- [x] Contract tests per provider show the SDK's real error type
  (evidence: same test file through 5 official-SDK paths: OpenAI Chat and Responses `BadRequestError` (`context_length_exceeded`, real numbers),
  Anthropic `BadRequestError` ("prompt is too long: N tokens > L maximum"), Gemini `ApiError` 400 INVALID_ARGUMENT, Bedrock `ValidationException`)
- [x] Standard criteria
  (evidence: README § Context window + options; Reference row; "Native errors per provider" lesson variant "Context window (auto)", checked to
  produce the context-length error on all 5 providers; `examples/openai-support-bot` handles `context_length_exceeded` with a "please shorten" reply,
  tested with `contextWindow`; indexes updated; `npm run check` exit 0: 186 library tests, 285 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- Checked **before** rules, scenarios and chaos (a real provider rejects oversized prompts whatever reply was scripted). Recorded as a fault
  (`matchedBy: 'contextWindow'`, `fault.error.details = { limit, inputTokens }`), so `fault` events fire and the request is not "unmatched".
- Key precedence: exact model id, then the longest matching glob; non-wildcard keys never substring-match.
- Only **input** tokens count (system, messages incl. history, tool definitions); output `max_tokens` doesn't.
- New optional `ErrorSpec.details` puts real numbers in OpenAI, Anthropic and Gemini messages, also usable via
  `faults.contextLengthExceeded({ details })`. Bedrock's native message has no numbers and is kept as-is.

#### R7e. `MOCK_LLM_SEED` (idea #16)
**Status:** Signed off: 2026-10-04
- [x] The `MOCK_LLM_SEED` env var overrides the `seed` option
  (evidence: `tests/unit/seed.test.ts` › "MOCK_LLM_SEED overrides the seed option (reproduce a CI run locally)" (env 99 beats option 5 and yields the same
  content as seed 99), "rejects a non-integer MOCK_LLM_SEED clearly; ignores an empty one")
- [x] The effective seed is exposed as `mock.seed` and included in strict-mode and chaos-related failure messages
  (evidence: › "defaults to 1, uses the seed option, and is exposed as mock.seed"; "local and remote UNEXPECTED LLM REQUEST reports say how to
  reproduce"; "the error the app receives from a chaos fault names the seed" (OpenAI 503 and Anthropic 529 keep native types);
  "matcher failure excerpts add a reproduction hint when chaos affected a request"; "a chaos run is reproducible". The control API and
  remote snapshots carry the seed (Playwright reports too))
- [x] Standard criteria
  (evidence: README § Reproducing a run (`MOCK_LLM_SEED`) + options; Reference `seed` row; retries lesson variant "Chaos (seeded)", checked on all 5
  providers to show the seed note in the app-facing error; `examples/openai-support-bot` adds a seeded-chaos test with `MOCK_LLM_SEED=${seed}` in its
  assertion messages; indexes updated; `npm run check` exit 0: 195 library tests, 290 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- The env var **wins** over the option (that's how a CI failure is replayed locally); a non-integer value throws, an empty value is ignored.
  The default stays **1**, so runs remain deterministic unless you choose otherwise.
- **Chaos faults' app-facing error messages get a short suffix** (`[mock-llm chaos fault · seed N · reproduce with MOCK_LLM_SEED=N]`) via a
  new `ErrorSpec.note`. Native type, status and envelope are unchanged; non-chaos faults keep their exact native message.
- Journal additions: `entry.chaos = { seed }` on chaos-hit requests and `journal.seed`; the control API's `/__mock/info` includes `seed`.

#### R7f. Content chaos (idea #15)
**Status:** Signed off: 2026-10-04
- [x] `chaos({ rate, weights: { refusal, empty, malformedToolCall, truncated, error } })` using the existing `edge.*`/`faults.*`
  (evidence: `src/core/chaos.ts` uses `edge.refusal/empty/truncated/malformedToolArgs` and the `faults` pool. `tests/unit/content-chaos.test.ts`
  shows each behaviour through the OpenAI SDK: refusal, empty, truncated (scripted text → `length`; tool-call JSON cut), malformedToolCall (scripted call
  keeps its name; otherwise the first offered tool; never without tools), error (native 503 + seed note). Content chaos runs the matched rule
  (its sequence advances, `matchedBy` kept); bad options are rejected)
- [x] Tests prove the same seed produces the same sequence of behaviours
  (evidence: › "the same seed produces the same sequence of behaviours" (24 requests, all 6 outcomes occur; a different seed differs); plus
  "a single candidate behaviour consumes no randomness" and a pinned golden errors-only sequence (seed 2024) guarding recorded seeds)
- [x] Journal records which chaos behaviour was applied
  (evidence: `entry.chaos = { seed, behaviour }` asserted in the tests above; matcher excerpts show "(chaos: <behaviour>)"; the playground Journal tab
  shows `chaos:<behaviour>`)
- [x] Standard criteria
  (evidence: README § Chaos (errors and bad content) with a behaviours table; Reference `chaos` row; edge-cases lesson variant "Content chaos (seeded)"
  (seed 28: e.g. OpenAI `truncated → malformedToolCall → malformedToolCall → truncated`, no errors on all 5 providers); `examples/openai-support-bot`
  adds "never crashes under content chaos" (asserts the exact set of behaviours and handled outcomes); indexes updated; `npm run check` exit 0:
  208 library tests, 295 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- **Content chaos changes the scripted reply** instead of replacing it: the matched rule runs (sequence advances), then the behaviour is applied
  (e.g. `truncated` cuts *that* text). `error` keeps the R7e behaviour: it short-circuits before rules and uses the `faults` pool.
- Chaos picks only among behaviours that apply to the request (`malformedToolCall` needs offered tools); if none apply, no chaos happens.
- No `weights` = errors only (unchanged). A single candidate behaviour consumes **no** randomness, so seeds recorded before R7f replay the same errors.
- `entry.chaos` gained `behaviour` (R7e's `{ seed }` → `{ seed, behaviour }`); R7e's test assertion was updated for the extra field.
- The playground journal now shows chaos (`chaos:<behaviour>` in the Journal tab).

#### R7g. Scenario expectation steps (ideas #10, #26)
**Status:** Signed off: 2026-10-04
**Depends on:** R2
- [x] Scenario files support `expectToolResult` / `expectRequest` steps, checked with the R2 matcher core
  (evidence: `tests/unit/expectations.test.ts`: a YAML file on disk drives a real OpenAI agent loop; met → `entry.expectations` pass and
  `toHaveMetExpectations()` passes; wrong tool-result content and wrong system prompt (`"/…/i"` RegExp) are each reported. The checks call
  `toHaveReturnedToolResult` / `toHaveReceivedRequest` on the single answered request)
- [x] A failed expectation names the scenario, rule and step
  (evidence: › "a failure names the scenario file, rule and step…" asserts `<file>: rules[0] ("refund-flow") › steps[1]: expectToolResult (request #n)`
  plus the core explanation and the tool result actually sent; in code: `rule "refund" › step 2`, `rule #1 › step 1`)
- [x] Standard criteria
  (evidence: README § Expectation steps + matcher row + modifiers; Reference rows; "Scenario files (YAML)" lesson variants "Expectation steps: met / not met"
  (live `toHaveMetExpectations`, verified on all 5 providers by `playground:check`); a separate Vitest process proves `useMockLLM()` fails only the test whose
  app sent the wrong tool result (without strict); remote path covered (`RemoteMockLLM.assertExpectations`), and `examples/playwright-chat-ui` runs an
  expectation through the fixture in Chromium; `examples/node-service-e2e`'s QA YAML gains `expectRequest` checked via `mock.assertExpectations()`;
  indexes updated; `npm run check` exit 0: 215 library tests, 305 lesson runs / 0 failures, 8/8 examples)
**Amendments** (decided during implementation, accepted by the maintainer at sign-off):
- Expectations are step **modifiers** that check the request the step answers (a step must still reply); not allowed on `fail` steps.
- A failed expectation doesn't break the app's flow (the reply is still sent). It's recorded on the entry, and the **test fails afterwards**:
  `useMockLLM` (Vitest/Jest) and the Playwright `llm` fixture call `assertExpectations()` after every test, **regardless of strict mode**.
- Parity in code: `reply(…, { expectToolResult, expectRequest })`; new `toHaveMetExpectations()` matcher (all adapters), `mock.assertExpectations()` /
  `RemoteMockLLM.assertExpectations()` throwing `ExpectationError`; `expectationReport` exported.
- Rules get readable labels for messages (`rule "name"`, `rule #n`, `default()`, `scenario "name"`).

---

## Phase V1.6: Release & maintenance

Decisions (maintainer, 2026-10-04): public **GitHub** repo, npm package **`mock-llm`** (unscoped; free as of 2026-10-04), **Renovate** for
updates, support **current + previous major** of each SDK/framework, and live drift detection (R18) **after R8**.

Key fact: mock-llm has **zero runtime dependencies**. SDKs are dev dependencies used to prove compatibility; users bring their own SDK versions.
"Supporting version X" therefore means "CI proves the mock works with X".

### R16. Release pipeline (first public release)
**Status:** In progress (started 2026-10-04)
**Goal:** anyone can `npm install -D mock-llm`, and every release is reproducible, verified and traceable to its source.
**Acceptance criteria**
- [ ] Git repository initialised with a sensible `.gitignore`, pushed to a public GitHub repo; `package.json` has `repository`, `homepage`, `bugs`, `author`
- [ ] Package correctness: the `yaml` optional peer dependency is restored (it was found missing on 2026-10-04); `files`/`exports`/`types` verified;
      `npm pack` contents checked in CI (only `dist`, README, LICENSE, CHANGELOG; no tests or examples)
- [ ] CI on every PR/push (GitHub Actions): `npm run check` (typecheck, library tests, playground:check, examples incl. Playwright/Chromium)
- [ ] Changesets: each change carries a changeset; a generated "Version Packages" PR bumps the version and writes `CHANGELOG.md`
- [ ] Publishing from CI only, via npm **trusted publishing** (OIDC, no long-lived token) with **provenance**; the publish job runs only from the release PR merge
- [ ] Pre-publish smoke test: install the packed `.tgz` into a clean temp project; `import 'mock-llm'`, `mock-llm/vitest`, `mock-llm/jest`, `mock-llm/playwright` resolve with types
- [ ] Post-publish verification: install the **published** version from npm into the examples and run them
- [ ] Documented release + semver policy (what's major/minor/patch for us; 0.x while the API settles; `next` dist-tag for pre-releases)
- [ ] First release `0.1.0` published; the npm page shows provenance
- [ ] Standard criteria: docs (README install + CONTRIBUTING/RELEASING) · `npm run check`
**Maintainer actions needed:** create or authorise the GitHub repo; npm account with 2FA; configure the trusted publisher on npmjs.com.
**Open question to verify during R16:** whether npm allows configuring a trusted publisher before a package's first publish, or whether a one-time
manual first publish is required.
**Amendments:** none

### R17. Dependency watch & compatibility matrix
**Status:** Proposed
**Depends on:** R16 (repo + CI)
**Goal:** know within a week when a third party releases, what it affects, and prove which versions we support.
**Acceptance criteria**
- [ ] Renovate configured: grouped PRs per ecosystem (OpenAI, Anthropic, Google GenAI, all `@aws-sdk/*` together, Vitest, Jest, Playwright incl. browsers,
      TypeScript, Node versions, example projects); release notes in PRs; schedule; lockfile maintenance
- [ ] Compatibility matrix in CI: **oldest supported + latest** of each SDK and test framework (current + previous major), on Node 20/22/24/26;
      runs on PRs (smoke subset) and weekly (full)
- [ ] Weekly **"latest"** job installs the newest release of every SDK/framework (even before Renovate's PR) and opens an issue on failure
- [ ] **SDK surface diff report:** a script that diffs the relevant parts of each SDK's type definitions between two versions (stream event types, content-block
      types, request parameters, endpoints, error classes) and posts the summary on the Renovate PR
- [ ] **SDK update playbook** in CLAUDE.md: classify each update as no impact / breaking (fix in the same PR with tests) / new feature to support
      (becomes a roadmap item with acceptance criteria) / deprecation; record the decision in the PR
- [ ] README **Compatibility** table generated from matrix results (not hand-written); optional peer ranges match the tested range
- [ ] Proven once end to end: a real SDK update PR goes through the playbook (or a deliberately downgraded-then-upgraded SDK as a drill)
- [ ] Standard criteria: docs · `npm run check`
**Amendments:** none

### R18. Live drift detection (real provider APIs)
**Status:** Proposed
**Depends on:** R8 (record proxy), R16
**Goal:** catch provider API changes that ship without an SDK release (new fields, event types, error shapes).
**Acceptance criteria** *(to be finalised when R8 is done)*
- [ ] Opt-in weekly CI job with API keys as GitHub secrets; tiny fixed prompts; a hard per-run token/cost budget; never runs on forks or PRs
- [ ] Records real responses (non-streaming, streaming, a tool call, one error) per provider and compares their **shape** (keys, types, event sequence),
      not values, with the mock's output for the same requests
- [ ] Differences open an issue with the diff; credentials are never logged or stored in fixtures
- [ ] Standard criteria
**Amendments:** none

---

## Phase V2: Serious AI QA

Each V2 item gets full checkbox criteria, written with the template above and agreed **before** it starts.

| Item | Ideas | Summary |
|---|---|---|
| **R8. Record proxy** | #13 | Opt-in passthrough to real providers with explicit keys; redacts credentials; writes fixtures; never enabled implicitly; tested against a local fake upstream (no real tokens in CI) |
| **R9. Replay** | #14 | `mock.replay(fixture)` matching on a normalized request with configurable strictness; clear error on a miss; accepts R8 fixtures and journal/wire JSON |
| **R10. Conversation state** | #4 | Conversation key (system + first user message); `ctx.state` in function responders and templates; reset semantics |
| **R11. Mutation primitives** | #29 | `mutate.dropFact / swapEntity / wrongTool / wrongToolArg / contradict` applied to scripted replies; seeded; no runner |
| **R12. Summary + framework report hooks** | #28 | `mock.summary()` (calls, unmatched, tokens, cost, faults); Playwright attachment and Vitest annotation helpers; no CLI reports |
| **R13. Node network interception** | #25 | Integrate MSW / undici interception so unmodified code with hardcoded provider hosts reaches the mock |
| **R14. CommonJS build** | (R5 follow-up) | Publish a CJS build alongside ESM so Jest's default (CommonJS) setup works without `--experimental-vm-modules` |
| **R15. Per-test isolation for parallel workers** | (R6 follow-up) | Namespaced rules + journal per test (e.g. a key header the app forwards), so parallel Playwright workers can share one mock; plus a launcher for apps that call the LLM while booting |

All V2 items: **Status:** Proposed (criteria to be written).
