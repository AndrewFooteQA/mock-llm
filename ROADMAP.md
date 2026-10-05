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
**Status:** Signed off: 2026-10-04
**Goal:** anyone can `npm install -D mock-llm`, and every release is reproducible, verified and traceable to its source.
**Acceptance criteria**
- [x] Git repository initialised with a sensible `.gitignore`, pushed to a public GitHub repo; `package.json` has `repository`, `homepage`, `bugs`, `author`
      *(public repo https://github.com/AndrewFooteQA/mock-llm; initial commit `c2ffb10` (141 files; no node_modules/dist/tgz/local settings; secret scan clean))*
- [x] Package correctness: the `yaml` optional peer dependency is restored (it was found missing on 2026-10-04); `files`/`exports`/`types` verified;
      `npm pack` contents checked in CI (only `dist`, README, LICENSE, CHANGELOG; no tests or examples)
      *(`scripts/check-pack.mjs` checks `npm pack --dry-run`: an allow-list of files, every `exports` target present, zero runtime deps. Output: "60 files,
      81.2 kB packed … ✔ package contents OK". Negative check: a stray `src/mock.ts` with CHANGELOG missing → exit 1 with both named. Run by `pack:check` in the CI `check` job and before every publish.)*
- [x] CI on every PR/push (GitHub Actions): `npm run check` (typecheck, library tests, playground:check, examples incl. Playwright/Chromium)
      *(`.github/workflows/ci.yml`: a `test` job on Node 22/24/26, plus a `check` job with Chromium installed (full check, then `pack:check`, then `changeset status` on PRs).
      First GitHub run (37217196351) failed on Node 22/24 only: a real fidelity bug (Gemini mid-stream error, see amendments). Fixed in `df817ab`; CI run
      37217569850 green on every job.)*
- [x] Changesets: each change carries a changeset; a generated "Version Packages" PR bumps the version and writes `CHANGELOG.md`
      *(`.changeset/config.json`; `release.yml` uses `changesets/action@v1` (Version Packages PR); CI fails a PR with no changeset; CLAUDE.md DoD item 4)*
- [x] Publishing from CI only, via npm **trusted publishing** (OIDC, no long-lived token) with **provenance**; the publish job runs only from the release PR merge
      *(0.1.0 was published from CI (release run 37217569854) with provenance, using the bootstrap token. On 2026-10-04 the maintainer configured the trusted
      publisher (`release.yml`), revoked the token and deleted the `NPM_TOKEN` secret (`gh secret list` is empty). `release.yml` no longer references any token.
      **Proven by 0.1.1**: changeset → Version Packages PR #1 (opened by the workflow) → merge → release run 37219890165 published with no secret in the repo.
      `npm view mock-llm@0.1.1 _npmUser` = "GitHub Actions <npm-oidc-no-reply@github.com>" (0.1.0, published with the token, shows the maintainer's account);
      provenance `https://slsa.dev/provenance/v1`.)*
- [x] Pre-publish smoke test: install the packed `.tgz` into a clean temp project; `import 'mock-llm'`, `mock-llm/vitest`, `mock-llm/jest`, `mock-llm/playwright` resolve with types
      *(`scripts/smoke-pack.mjs`: a fresh project installs the tarball offline; a real request goes through the installed package; `tsc --strict` on imports from all 4 entry points.
      Output: "✔ runtime … ✔ types: mock-llm, mock-llm/vitest, mock-llm/jest, mock-llm/playwright". Runs in `pack:check`.)*
- [x] Post-publish verification: install the **published** version from npm into the examples and run them
      *(`scripts/verify-published.mjs` (`npm run verify:published [version]`): copies each example, pins `mock-llm` to the published version, installs from the registry with retries for
      propagation, and runs its tests. For 0.1.0 the CI step was skipped (see the amendment on `changesets/action` v2), so it was run by hand: 8/8 examples pass against
      `mock-llm@0.1.0` from npm. For 0.1.1 the CI step ran but 1/8 failed (ETARGET: stale cached package metadata, see the amendments). Fixed with `--prefer-online`;
      a rerun by hand gave 8/8 against `mock-llm@0.1.1` from npm. **The fix will first run in CI at the next release.**)*
- [x] Documented release + semver policy (what's major/minor/patch for us; 0.x while the API settles; `next` dist-tag for pre-releases)
      *(`RELEASING.md`: flow, versioning table, Node support policy, `changeset pre enter next`, deprecate rather than unpublish, the token bootstrap and a post-release checklist)*
- [x] First release `0.1.0` published; the npm page shows provenance
      *(`npm view mock-llm`: version 0.1.0, dist-tag `latest`, `dist.attestations.provenance.predicateType` = `https://slsa.dev/provenance/v1`; tag `v0.1.0` and
      the GitHub Release https://github.com/AndrewFooteQA/mock-llm/releases/tag/v0.1.0 are on the published commit `df817ab`. v0.1.1's tag and release were created by the workflow.)*
- [x] Standard criteria: docs (README install + CONTRIBUTING/RELEASING) · `npm run check`
      *(README "Install" section (Node ≥ 22, peers, 0.x policy, tested SDK versions) and Development links; `CONTRIBUTING.md`; `RELEASING.md`; `CHANGELOG.md` 0.1.0. The Reference page
      notes the requirements and links CHANGELOG/RELEASING; `playground:check` now fails on any broken `/docs/*.md` link (negative check: 404 caught). `npm run check` green.)*
**Maintainer actions needed:** create or authorise the GitHub repo; npm account with 2FA; configure the trusted publisher on npmjs.com.
**Open question (answered):** npm can't configure a trusted publisher until the package exists, so the first publish needs a token.
**Amendments:**
- *First publish via a short-lived token.* `0.1.0` is published by `release.yml` using a 7-day granular token held only as the `NPM_TOKEN` repo secret.
  Provenance still applies via GitHub OIDC. After that: configure the trusted publisher, set "require 2FA and disallow tokens", and delete the token and secret
  (steps in RELEASING.md).
- *Node ≥ 22* (`engines` was `>=20`; Node 20 reached end-of-life on 2026-04-30). CI tests 22, 24 and 26.
- *Source maps are not shipped* (`src/` isn't in the package, so they would point at missing files).
- *Fidelity fix found by CI:* on Node 22/24, `fetch` delivered the last SSE chunk and Gemini's bare-JSON mid-stream error in one read, so the SDK threw
  "Incomplete JSON segment at the end" instead of `ApiError`. The mock now pauses ~50 ms before a mid-stream error frame, as the real API does. Regression test:
  `gemini: errors › mid-stream error arrives as its own network read, even for a slow reader`. It failed 3/3 on Node 22 before the fix and passed 5/5 after.
- *The token needed 2FA bypass:* the account has 2FA, so the bootstrap token must have "Bypass 2FA" enabled. The first attempt returned E403 and nothing was published.
- *`changesets/action` v1 → v2:* v1 parses log lines that Changesets CLI v3 no longer prints. So it published 0.1.0 without noticing: no tag, no GitHub Release,
  and verification skipped. v2 reads the CLI's `CHANGESETS_OUTPUT` file. The 0.1.0 tag and release were created by hand, and verification was run by hand.
  v2 names single-package tags `vX.Y.Z`, so the 0.1.0 tag/release was renamed from `mock-llm@0.1.0` to `v0.1.0` to match.
- *0.1.1 release (tokenless proof),* requested by the maintainer. It contains no library changes. Setup issues found and documented in RELEASING.md:
  - the repo setting "Allow GitHub Actions to create and approve pull requests" is needed for the Version Packages PR;
  - the trusted publisher needs an exact owner/repo/workflow and an empty environment (otherwise E404 "package not found");
  - the trusted publisher needs **Allow npm publish** under Allowed actions, because the default is stage-only (otherwise E403 "OIDC permission denied").
  `release.yml` now prints npm's OIDC log lines when publishing fails, and the bootstrap token is gone (the workflow references none).
- *verify-published retried with stale metadata:* npm cached the version list from before 0.1.1 propagated, so all 5 retries failed with ETARGET. It now
  installs with `--prefer-online`.

### R17. Dependency watch & compatibility matrix
**Status:** Signed off: 2026-10-04
**Depends on:** R16 (repo + CI)
**Goal:** know within a week when a third party releases, what it affects, and prove which versions we support.
**Acceptance criteria**
- [x] Renovate configured: grouped PRs per ecosystem (OpenAI, Anthropic, Google GenAI, all `@aws-sdk/*` together, Vitest, Jest, Playwright incl. browsers,
      TypeScript, Node versions, example projects); release notes in PRs; schedule; lockfile maintenance
      *(`renovate.json`: one group each for OpenAI, Anthropic, Google GenAI (+ google-auth-library), AWS (`@aws-sdk/*` + `@smithy/*`), Vitest, Jest, Playwright, TypeScript,
      Node types, Changesets, GitHub Actions and "example projects". Root and examples are in the same group, `examples/` is un-ignored, peer ranges are never auto-bumped,
      and there are SDK labels for the diff workflow. Schedule: Mondays before 7am; lockfile maintenance on. Release notes are Renovate's default. `renovate-config-validator`:
      "Config validated successfully". Node lines: see the weekly node-check below. **Live:** Dependency Dashboard issue #4, and PR #5 on branch `renovate/openai-sdk` with
      labels `dependencies` and `sdk-update`, one PR covering the root and 4 examples, with release notes 7.26–7.28 in the body.)*
- [x] Compatibility matrix in CI: **oldest supported + latest** of each SDK and test framework (current + previous major), on Node 20/22/24/26;
      runs on PRs (smoke subset) and weekly (full)
      *(`compat/targets.json` + `scripts/compat.mjs` + `.github/workflows/compat.yml`: PRs run a smoke subset (4 SDKs at their oldest, on Node 24); weekly, on demand and on Renovate PRs
      run the full matrix, 21 jobs (9 targets × oldest/latest, plus everything-latest on Node 22/24/26). Each run works in a temp copy of the repo. Framework targets run the
      examples outside the repo against the packed tarball. Local run, 2026-10-04: **18/18 pass**. `actionlint` is clean. **CI: Compatibility run 37233971456
      (workflow_dispatch, full): 21/21 jobs green**, and the PR smoke subset runs on every PR.)*
- [x] Weekly **"latest"** job installs the newest release of every SDK/framework (even before Renovate's PR) and opens an issue on failure
      *(`compat.mjs run-all-latest`: every target at latest together, plus every example with its SDKs/frameworks at latest, on each Node line. The workflow's `report`
      job opens or updates a `compat-failure` issue on any failure, or when `node-check` finds a Node line to add or drop, and opens a "Compatibility results" PR with
      `compat/results.json` and the README table. Run 37233971456: the everything-latest jobs passed on Node 22/24/26, and the report job opened PR #3 "Compatibility
      results" with the merged table. No failures, so no issue was opened. The issue path is exercised by `node-check` in the unit tests and the workflow's shell; it
      hasn't fired for real yet.)*
- [x] **SDK surface diff report:** a script that diffs the relevant parts of each SDK's type definitions between two versions (stream event types, content-block
      types, request parameters, endpoints, error classes) and posts the summary on the Renovate PR
      *(`scripts/sdk-surface-diff.mjs`, plus `.github/workflows/sdk-diff.yml`, which comments once per Renovate PR and updates the comment in place. Real runs: openai 7.25.0 → 7.28.0
      gave 3 changed types (`Stream` flagged); @anthropic-ai/sdk 0.66.0 → 0.131.0 gave 172 added types, including the new `ContentBlock` union members. Tests:
      `tests/unit/sdk-surface-diff.test.ts` (10), which found and fixed two parser bugs. **Posted on PR #5** by the `SDK surface diff` workflow, and updated in place after the
      member-literal fix: it now lists `ChatCompletionContentPartImage.ImageURL` +`detail:'original'`.)*
- [x] **SDK update playbook** in CLAUDE.md: classify each update as no impact / breaking (fix in the same PR with tests) / new feature to support
      (becomes a roadmap item with acceptance criteria) / deprecation; record the decision in the PR
      *(CLAUDE.md › "SDK updates (dependency PRs)": read → classify (4 classes, incl. `sdkAtLeast()` gating, SDK-side only) → floors → record; linked from README,
      CONTRIBUTING and RELEASING › Compatibility policy)*
- [x] README **Compatibility** table generated from matrix results (not hand-written); optional peer ranges match the tested range
      *(`compat.mjs readme` writes between markers from `compat/results.json`. `compat lint` in `npm run check` fails when they're stale: it caught one real case,
      after the Vitest floor moved. Peers: `vitest >=4.0.1`, `@jest/globals >=29`, `@playwright/test >=1.56`, `yaml >=2`, enforced by
      `tests/unit/compat.test.ts › optional peer ranges match the tested floors`. Changeset `compat-matrix.md` (minor, with a migration note).)*
- [x] Proven once end to end: a real SDK update PR goes through the playbook (or a deliberately downgraded-then-upgraded SDK as a drill)
      *(PR #5, openai 7.25.0 → 7.28.0, a real Renovate PR. Read the diff and release notes → classified **no impact** → proven with a new contract test (`a056e36`) through 7.28.0
      → the full matrix, CI and the surface diff are all green on `a056e36` (runs 37235436328 / 37235436351 / 37235436359) → decision recorded:
      https://github.com/AndrewFooteQA/mock-llm/pull/5#issuecomment-5984496656. It also exposed two tooling gaps, fixed in `460157e` (see the amendments).
      **Merging PR #5 is the maintainer's call.**)*
- [x] Standard criteria: docs · `npm run check`
      *(README Install → Compatibility section, plus a chunk-interval tip; RELEASING › Compatibility policy and Renovate setup; CONTRIBUTING; the CLAUDE.md playbook and layout;
      a Reference page note. `npm run check` is green locally: 255 tests, 305 lesson runs, 8/8 examples, compat lint. CI run 37233944664 is green on `8cfe162`.)*
**Amendments:**
- *Node 22/24/26* rather than 20/22/24/26 (Node 20 support was dropped in R16).
- *What "oldest supported" means.* For a package with real majors (openai, @google/genai, Vitest, Jest, TypeScript), it is the first
  release of the previous major (`6.0.0`, `1.0.0`, `4.0.0`, `29.0.0`, `6.0.2`). For packages that are 0.x or have had a single
  major for years (@anthropic-ai/sdk, @aws-sdk/*, Playwright, yaml), it is the first release at least 12 months old when the floor is
  set: `0.66.0`, `3.906.0`, `1.56.0`. yaml uses `2.0.0`, the previous major's floor being 1.x, which predates scenario files. The floors live in
  `compat/targets.json`, are reviewed quarterly, and raising one is a `minor` bump.
- *SDKs are not peer dependencies.* The app under test owns them, so "supported SDK versions" is a compatibility claim proven by the
  matrix. Our test-framework integrations (`vitest`, `@jest/globals`, `@playwright/test`) and `yaml` are peers, and their ranges change to
  match the tested floors (e.g. `vitest >=1` becomes `>=4`). That narrowing is a `minor` release.
- *TypeScript is in the matrix* as a consumer check: our published `.d.ts` files must type-check in user projects on the oldest
  supported TypeScript (6.0.2) as well as the latest.
- *Matrix size:* weekly full = each package {oldest, latest} on Node 24, plus an "everything latest" run on Node 22/24/26. PRs run a
  smoke subset: the oldest of the four provider SDKs on Node 24.
- *The surface diff parses `.d.ts` files itself* rather than using the compiler API (TypeScript 7 only has an unstable JS API).
- *Renovate needs the Renovate GitHub App installed on the repo:* a maintainer action.
- *First matrix findings (2026-10-04, before any fixes):* `@anthropic-ai/sdk@0.66.0` and `@aws-sdk/client-bedrock-runtime@3.906.0` pass all 216
  library tests. `openai@6.0.0` fails 3 (Responses streaming/refusal and a strict-mode chaos test) and `@google/genai@1.0.0` fails 4 (error
  envelopes, mid-stream error, env config). Each failure is triaged as a mock incompatibility (fix it) or a test using newer SDK API
  (version-gate the test, and document the floor).
- *Triage results (2026-10-04).* None of these were mock wire bugs. The matrix found:
  - **openai 6.0.0:** two SDK-behaviour changes. `finalResponse().output_text` arrived in **6.45.0**, and in-stream errors are wrapped as `APIError` from
    **7.5.0** (earlier SDKs reject with the raw `error` event). Both are bisected and gated with `sdkAtLeast()` (`tests/helpers/sdk-version.ts`); the
    wire-side assertions are unchanged.
  - **@google/genai:** `ApiError` arrived in **1.6.0** and `GEMINI_API_KEY` in 1.4.0, so the floor is 1.6.0. The Vertex test now loads `google-auth-library` the
    way genai resolves it (a v10 auth client can't be used by an SDK built on v9).
  - **Vitest 4.0.0:** broken in any fresh install (it resolves a Vite 7 release it can't run: "Unknown method: getBuiltins"), so the floor is **4.0.1**.
  - **Jest 29:** its default `testMatch` excludes `.mjs`, so the Jest example (and the README snippet) now set `testMatch`.
  - **Playwright 1.56:** the example's mid-stream test used a 600 ms window, which 1.56's retry back-off can poll straight over. The window is now 1200 ms,
    with a README tip. Chunk timing at the mock was verified (601/1204/1805 ms).
  - **TypeScript 6** also needs `--ignoreConfig` in `smoke-pack`.
  - **Runner fixes:** examples run outside the repo, because Vitest 4 picks up a parent `vitest.config.ts`. Playwright 1.56's browser download hung once locally on Node 26
    (it worked on Node 22, cause not investigated). CI runs these targets on Node 24.
- *What the live Renovate PR (#5, openai 7.25.0 → 7.28.0) exposed.* Both gaps are fixed on `main`:
  - **The surface diff ignored member types.** The release notes said "allow original image detail", but the diff didn't show it, because only member *names*
    were compared. It now records the string literals in a member's type (`detail:'original'`), with a regression test.
  - **CI required a changeset on every PR**, so every Renovate PR failed `check`. `scripts/needs-changeset.mjs` now requires one only when something that
    ships changed (src/ or package.json release fields), as CLAUDE.md says, with tests.
  - **Mend installed Renovate in Silent mode** by default. The maintainer switched it to automated PRs with "require config file" (RELEASING.md › Renovate).
- *Concurrency:* a separate review session edited the working tree during R17 (its changes are tracked as its own changeset and R19). R17 was paused until
  it finished.

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

### R19. Example coverage: examples as consumer tests, plus a coverage report
**Status:** Signed off: 2026-10-05 (the 25 exemptions in `examples/coverage.json` accepted)
**Depends on:** none (waits for the item in progress, per the one-at-a-time rule)
**Goal:** the examples are the only tests that install the *packed* package into separate projects and use it like a
user. Make them cover what only they can catch (packaging and types, test-framework integration, real app patterns
for every provider), and make gaps visible with a script so coverage can't slip silently.

**Why (findings, 2026-10-04 review):**
- `claude-code-cli` exits 0 when the `claude` CLI isn't on PATH, so `test:examples` shows ✔. CI never installs the CLI,
  so the README's Claude Code support has never been tested in CI.
- None of the TypeScript examples is type-checked (Vitest strips types; there's no `tsconfig.json`). The published
  `.d.ts` files go unchecked in a real project: matcher augmentations, option types, `ReplyOptions`. `smoke-pack` only
  checks that the imports resolve.
- The `scenarioFiles` + `reset()` bug (fixed 2026-10-04) shipped in 0.1.0 and 0.1.1. No example uses `scenarioFiles`
  across more than one test, so nothing could catch it. A consumer project written that day failed 6/6 against the
  published 0.1.1.
- Feature use by examples, from grepping their tests and app code:

  | Area | Covered by an example | Not covered by any example |
  |---|---|---|
  | Streaming via the SDK | Bedrock ConverseStream, OpenAI Chat (playwright server) | Anthropic `messages.stream()`, Gemini `generateContentStream`, OpenAI Responses `stream()` |
  | Non-chat endpoints | none | embeddings (all providers), `countTokens` / CountTokens, `models.list` |
  | Bedrock operations | ConverseStream | Converse, InvokeModel (Claude body), InvokeModelWithResponseStream, CountTokens |
  | Gemini | AI Studio | Vertex AI (`vertexai: true`, `:predict` embeddings) |
  | Faults | `rateLimit`, `overloaded`, `timeout`, `streamCut`, `streamError` | `connectionReset`, `server`, `auth` (+ `apiKeys` option), `contextLength` fault, `raw` |
  | Responders | `reply`, `replyToolCall(s)`, `replyTemplate`, `replyLorem`, `replyFromSchema` | `replyToolCallFromSchema`, `replyEcho`, `{ thinking }` |
  | Lifecycle | `useMockLLM` per test; `scenarioFiles` in one `node:test` suite with no reset | `useMockLLM({ scenarioFiles })` across tests; strict + expectation steps together in Vitest |
  | Assertions | trajectory, requested/returned tool, received request/prompt(/times), tokens, unmatched | `toCostLessThan`, `journal.cost()`, `pricing`, `toHaveOfferedTool` |
  | Other | `chunk` events, `[[mock:…]]` | `x-mock-scenario` header, the journal `wire` record, `request` / `fault` / `unmatched` events |

**Acceptance criteria**

*Honest results*
- [x] `claude-code-cli` runs in CI: the `check` job installs the Claude Code CLI, and the example asserts on the requests
      the mock saw (evidence: CI run link with the example's request list in the log)
      *(`ci.yml` and `release.yml` install `@anthropic-ai/claude-code` before `npm run check`. The example asserts with plain-function matchers (prompt as user message, Claude model, reply printed) and prints the request list. Locally: 5/5 checks ✔. **CI run 37289876266** (`2f93982`), check job log: `Claude Code 2.1.289`, `POST /v1/messages -> 200 (default)`, then ✔ for each of the 5 checks and `✔ claude-code-cli`. The first push (`d83cc92`) exposed that npm 12 (in the release job) blocks the CLI's postinstall; both workflows now install it with `--allow-scripts=@anthropic-ai/claude-code`.)*
- [x] `scripts/test-examples.mjs` reports three outcomes, ✔ passed / ✘ failed / ⊘ skipped (with the reason). An example
      skips by exiting with a documented code (e.g. 77) instead of 0. `test:examples` fails on a skip when `CI=true`
      (evidence: output with the CLI absent locally showing ⊘; negative check: the same run with `CI=true` exits 1)
      *(✔ / ✘ / ⊘. `claude-code-cli` exits 77 without the CLI. With the CLI absent (PATH without `claude`): `⊘ claude-code-cli (skipped: see its output above)`, exit 0. **Negative:** the same with `CI=true` → `✘ 1 example(s) skipped, which is not allowed in CI`, exit 1. With the CLI: ✔. `compat.mjs` and `verify-published.mjs` record 77 as a skip, not a failure.)*

*Types checked like a user's project*
- [x] Each TypeScript example has a `tsconfig.json` (`strict`, `noEmit`, `moduleResolution: bundler` or `nodenext`) and
      its `test` script runs `tsc --noEmit` before the tests (evidence: `npm test` output in each)
      *(`bedrock-streaming-summarizer`, `claude-tool-agent`, `gemini-structured-extraction`, `openai-support-bot` and the new `rag-knowledge-base` each have `tsconfig.json` (`strict`, `noEmit`, `NodeNext`) and `"test": "tsc --noEmit && vitest run"`; `tsc` is clean in all five. It caught three real mistakes while writing the examples: an invalid `EntryFilter` key, `CostReport.totalUsd` (→ `total`), and an `as never` hack, now removed.)*
- [x] The type check covers the matcher augmentations (`expect(mock).toHaveToolTrajectory(...)`), `MockLLMOptions`,
      `ReplyOptions`, scenario-file types (`ScenarioFile`) and `JournalEntry` fields the tests read (evidence: a
      deliberately wrong matcher argument fails `tsc` in one example; record the error, then revert)
      *(Typed uses: matchers throughout, `MockLLMOptions` (rag), `ReplyOptions` and `JournalEntry` (claude-tool-agent, openai-support-bot), `ScenarioFile` (openai-support-bot baseline test). **Negative:** `toHaveToolTrajectory(42, [...])` in claude-tool-agent → `error TS2345: Argument of type 'number' is not assignable to parameter of type '(string | ToolStep)[]'`; reverted.)*

*Streaming through every chat SDK*
- [x] `claude-tool-agent`: the app streams its final answer with `messages.stream()`; the test checks the accumulated
      text and `finalMessage()`, including a tool-use turn delivered by streaming
      *(`runAgent(..., { stream: true, onText })` uses `messages.stream()` + `finalMessage()`. The test `streams every turn, including a tool-use turn…` checks the tool call reassembled from streamed input, deltas in order (more than 2 pieces) and both turns with `stream: true`.)*
- [x] `gemini-structured-extraction`: a streamed extraction with `generateContentStream`, plus one mid-stream error
      (`faults.streamError`) that the app reports
      *(`extractInvoiceStreaming` (`generateContentStream`, progress callback). Tests: exact chunks → invoice plus progress `[30, 80, n]`. `faults.streamError({ afterChunks: 2, overloaded })` → `ExtractionError` "stopped part-way… (HTTP 503)".)*
- [x] `jest-travel-assistant`: a streamed Responses turn (`responses.stream()`), checked against `finalResponse()`
      *(`ask(q, { onText })` uses `responses.stream()` + `finalResponse()`. The test streams a tool turn and the answer: deltas (more than 1) joined equal the final text, both requests `stream: true`.)*

*Non-chat endpoints: new example `rag-knowledge-base`*
- [x] A new standalone example: a small retrieval-augmented app that embeds documents, ranks them by cosine similarity
      and answers with the top passages in the prompt. Its app code (`src/`) contains nothing mock-specific
      *(`examples/rag-knowledge-base`: `src/embedders.ts`, `tokens.ts`, `kb.ts` (cosine index, budgeted answer, `pickModel`), nothing mock-specific. 14 tests. The README explains that mock embeddings are deterministic but not semantic, so the FAQ matches question to question.)*
- [x] It covers embeddings through OpenAI (default base64 encoding *and* `encoding_format: 'float'`), Gemini AI Studio
      (`embedContent`, batch) and Gemini Vertex AI (`:predict`, with a static OAuth token as in
      `tests/contract/gemini.test.ts`), and Bedrock (Titan or Cohere embeddings via InvokeModel)
      *(`it.each` over OpenAI base64 / `float`, Gemini AI Studio batch, Gemini **Vertex** `text-embedding-005` → `:predict` (OAuth `Bearer test-token`, path asserted) and Bedrock Titan v2 via InvokeModel. Base64 and float decode to the same vectors (`encoding_format` recorded as `base64` / `float`).)*
- [x] It covers token counting before sending (`countTokens` on Anthropic, Gemini and Bedrock CountTokens), with the app
      trimming context to a budget, plus `models.list` used to pick a model
      *(Anthropic `messages.countTokens`, Gemini `models.countTokens`, Bedrock `CountTokens`: each positive and grows with the prompt. `answer()` drops the lowest-ranked passages until the prompt fits (a 60-token budget → fewer than 4 passages, the best one kept). `pickModel` uses `models.list` with the `models` option; a mock listing no Claude model → a clear error.)*
- [x] It asserts the top passages reached the prompt (`toHaveReceivedPrompt`) and the cost stayed under a budget
      (`toCostLessThan`, `journal.cost()` with a custom `pricing` entry)
      *(`toHaveReceivedPrompt('[1] <reset passage>', { in: 'user' })`, the system prompt, `toCostLessThan(0.01)`, `journal.cost()` with `unpriced: []`, and `byModel['claude-sonnet-5-5'].usd === total` under custom `pricing`.)*
- [x] Listed in all three example indexes: `examples/README.md`, the README "Example projects" table and the Reference
      page's example table in `playground/public/app.js`
      *(Rows in `examples/README.md`, the README "Example projects" and the Reference page. All three tables were rewritten from `coverage:examples --by-example`.)*

*Lifecycle and scripting*
- [x] `openai-support-bot` (or `claude-tool-agent`): a shared YAML baseline via `useMockLLM({ scenarioFiles, strict: true })`
      used by **at least three tests**; each later test relies on the baseline (including a sequence or `once` rule
      starting over) and adds its own `when()` override (evidence: removing the reapply from `reset()` makes these
      tests fail; record it, then restore)
      *(`test/baseline.test.ts` + `test/scenarios/support-baseline.yaml`, `useMockLLM({ scenarioFiles, strict: true })`, 8 tests: the sequence restarts in the next test, the `once` outage fires again, a `when()` override wins and doesn't leak, typed `ScenarioFile` loaded on top. **Negative:** with the re-apply removed from `reset()` (`src/mock.ts`), 7/8 fail (the first passes because `start()` applies it once); restored, 20/20 pass.)*
- [x] A Vitest test with an expectation step **and** strict mode, with the app's error swallowed, that fails for the
      expected reason, checked with a posttest script like playwright-chat-ui's `check-expected-failures.mjs`
      *(`test/should-fail/strict-expectation.ts` (outside the default include), run by the `posttest` `check-expected-failures.mjs`, which requires a non-zero exit and both reports (`SCENARIO EXPECTATION FAILED` with `rules[0] ("refund") › steps[0]: expectRequest`, and `UNEXPECTED LLM REQUEST` naming the question). **Negative:** with the expectation made to pass → `✘ … missing /SCENARIO EXPECTATION FAILED…/`, exit 1. Note: `it.fails` was tried first; it reports "passed" with no failure message, so it can't verify the reason.)*
- [x] `x-mock-scenario` header used by one app that forwards it (e.g. `node-service-e2e` passes a request header through)
      *(`node-service-e2e`: the service forwards the headers listed in `LLM_FORWARD_HEADERS` on each SDK call (a generic tracing pattern, nothing mock-specific). Tests: `x-mock-scenario: vip` (QA file scenario) plus `x-request-id` asserted via `toHaveReceivedRequest({ headers })`, `rate-limit` → 503, and a sweep of **every built-in scenario** (each gives a reply or a clean 503). The sweep found the service had no LLM timeout (SDK default 10 min); it now has `LLM_TIMEOUT_MS`.)*

*Faults and awkward outputs*
- [x] `connectionReset` and `server` (500): the app retries or degrades; the test asserts the SDK's retry count from the journal
      *(openai-support-bot: reset, then 500, then the reply with `maxRetries: 2`; journal `['reset', 500, 200]`. Reset every time with `maxRetries: 1` → `unavailable` after 2 requests.)*
- [x] `auth`: a mock started with `apiKeys` and an app configured with the wrong key shows a "check your API key" error
      (the SDK's 401 class)
      *(A second mock with `apiKeys: ['sk-right']`: the wrong key → `{ kind: 'misconfigured', text: '…(check the API key).' }`, journal `[401]` (no retry); the right key → answer. A scripted `faults.authError()` → the same.)*
- [x] `faults.contextLength` scripted directly (separate from the `contextWindow` option already covered)
      *(`faults.contextLengthExceeded({ details: { limit: 8192, inputTokens: 9001 } })` on a short question → `too_long`.)*
- [x] `{ thinking }` in `claude-tool-agent`: the app hides reasoning from the user but logs it; the test checks both
      *(`reply(text, { thinking })` typed as `ReplyOptions`: the answer excludes the reasoning and `log` received `thinking: …`, both non-streaming and streaming. Requests carry `thinking: { type: 'adaptive' }` (from `request.raw`).)*

*Provider surface*
- [x] `bedrock-streaming-summarizer` adds non-streaming Converse and InvokeModel with a Claude body (summary length
      limits via `max_tokens` → `stopReason: 'max_tokens'`)
      *(`summarizeOnce` (Converse) and `summarizeWithInvokeModel` (Claude Messages body). `describe.each` checks the full text, `maxTokens: 200` sent, and `edge.truncated` → `stopReason: 'max_tokens'`, `truncated: true`. Also `streamWithInvokeModel` (InvokeModelWithResponseStream).)*
- [x] `gemini-structured-extraction` runs one extraction through a Vertex AI client as well as AI Studio
      *(The Vertex AI test: `vertexai: true`, static OAuth token; journal path `/projects/my-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent`, `authorization: Bearer test-token`.)*

*Coverage report script*
- [x] `scripts/example-coverage.mjs` (`npm run coverage:examples`) builds a **feature inventory** from the source, not
      from a hand-kept list:
      - exported values from `src/index.ts`
      - keys of `faults`, `edge` and `builtinScenarios`
      - the names of `assertions` (every matcher)
      - `RuleBuilder` methods
      - `MockLLMOptions` and `Matcher` keys (read from the TypeScript source)
      - scenario-file step actions and modifiers (`scenario-file.ts`)
      - event names (`MockLLMEvents`)
      *(Extracted from source: `exportedValues(src/index.ts)` (value exports only) plus each test-framework entry point's exports; `topLevelKeys` of `faults`, `edge`, `builtinScenarios`, `assertions`, `RuleBuilder`, `MockLLMOptions`, `Matcher` and `MockLLMEvents`; `ACTIONS` / `MODIFIERS` from `scenario-file.ts`. 199 features. Braces in strings and comments are masked.)*
- [x] Plus a small **SDK-surface map** in `examples/coverage.json` for things the inventory can't see:
      - feature → patterns, per provider and SDK call (e.g. `anthropic.stream` → `/messages\.stream\(/`;
        `bedrock.invokeModel` → `/InvokeModelCommand/`; `gemini.vertex` → `/vertexai:\s*true/`)
      - endpoints (embeddings, countTokens, models) per provider
      *(`examples/coverage.json` › `surface`: 21 SDK calls and endpoints (chat and stream per provider, Responses, embeddings, countTokens, models, Vertex, InvokeModel (+stream), Claude Code).)*
- [x] It scans each example's tests, app code, scenario files and config. Generated, lock and `node_modules` files are
      skipped. It reports each feature as **covered** (with the examples and files that use it), **exempt** (listed in
      `examples/coverage.json` with a one-line reason, e.g. `effectiveSeed`: internal helper) or **uncovered**
      *(`filesOf` skips `node_modules`, `test-results`, `dist`, lockfiles, READMEs and `tsconfig*.json` (whose `"strict": true` had falsely counted as the `strict` option). Exports count only when imported from `mock-llm` (a comment mentioning `assertions` had counted).)*
- [x] Output: a readable table grouped by area (default), `--json` for tooling, and a per-example feature list to check
      the three example indexes against (rows written from use, per `CLAUDE.md`)
      *(Default: a table per area with examples per feature; `--json`; `--by-example` (used to rewrite the three indexes).)*
- [x] Gate: `examples/coverage.json` has a `required` list (initially: every fault, every provider's chat
      non-streaming + streaming, embeddings per provider, the three test-framework adapters, strict mode, scenario
      files, expectation steps). Exit 1 if a required feature is uncovered or an inventory item is neither covered nor
      exempt, so a **new export, fault, matcher or option** fails the check until an example uses it or it's exempted
      with a reason. Runs in `npm run check` (after `test:examples`) and in CI
      *(`required`: all 14 faults, chat and stream for all 4 providers (plus Responses), embeddings for 3 providers, the 3 adapters, `strict`, `scenarioFiles`, `expectRequest` / `expectToolResult`, `toHaveMetExpectations`. It runs in `npm run check` after `test:examples` (so in CI's `check` job).)*
- [x] Unit tests for the script in `tests/unit/` (inventory extraction from fixtures, pattern matching, exempt and
      required handling, exit codes). Negative checks recorded: deleting a fault's only example use fails with that
      fault named; adding an unused export fails until exempted
      *(`tests/unit/example-coverage.test.ts` (9): extraction from fixtures (strings, comments, nesting, type-only exports), the real source, covered / exempt / uncovered, stale exemptions, the surface map. **Negatives on the real repo:** removing the only `faults.raw` use → `required feature "fault:raw" is not used by any example`, exit 1. Adding `export { approxTokens as estimateTokens }` → `"export:estimateTokens" is neither used by an example nor exempt`, exit 1. Both restored → exit 0.)*
- [x] `CLAUDE.md` definition of done (Examples section) and `CONTRIBUTING.md` mention the script and how to exempt a
      feature
      *(CLAUDE.md Examples: the coverage gate and how to exempt, `tsc` in examples (no `as any` / `as never`), and exit 77 for skips; Layout updated. CONTRIBUTING item 3 has an exemption example.)*

*Wrap-up*
- [x] After the work above, `npm run coverage:examples` reports no uncovered items; exemptions are reviewed by the
      maintainer (evidence: the final table in the sign-off summary)
      *(`199 features: 174 covered, 25 exempt, 0 uncovered`. Same in CI (run 37289876266). The 25 exemptions are in the sign-off summary table for maintainer review; signing off accepts them.)*
- [x] Standard criteria: tests · docs (README "Example projects", `examples/README.md`, Reference page example table,
      `CLAUDE.md`, `CONTRIBUTING.md`) · examples · `npm run check`
      *(Tests: 271 library tests (+ the coverage, schema and needs-changeset suites), 9/9 examples, 305 lesson runs; `npm run check` green locally. Docs: the three indexes, 7 example READMEs plus the new one, README (Development, `fakeFromSchema`), Reference (`fakeFromSchema` row, example table), CLAUDE.md, CONTRIBUTING. CI and Release are green on `2f93982` (runs 37289876266, 37289876438). Release opened Version Packages PR #10 (0.2.1).)*

**Out of this item (on purpose):**
- Oldest supported SDK versions: that's R17's compatibility matrix.
- Parallel Playwright workers: R15.
- Testing against real provider APIs: R18.

**Amendments:**
- *A library bug found by the coverage work:* `fakeFromSchema` was exported but required an `Rng`, which isn't exported, so
  users couldn't call it. It now takes `fakeFromSchema(schema, { seed, violate })` (the `Rng` form still works), is
  documented, and has a regression test. Changeset `fake-from-schema.md` (patch).
- *An example bug found by the scenario sweep:* `node-service-e2e` had no LLM timeout, so the `timeout` scenario hung it
  for the SDK default of 10 minutes. It now has `LLM_TIMEOUT_MS`, set to 3 s in tests, which is longer than a 429's
  1 s `retry-after` plus the retry. At 1 s, rate limits surfaced as timeouts.
- *Vitest expected failures* use a separate `test/should-fail/` suite and a `posttest` checker rather than `it.fails`.
  `it.fails` reports "passed" with no message when useMockLLM's afterEach throws, so it can't check the reason.
- *Mock embeddings aren't semantic* (deterministic per text). `rag-knowledge-base` ranks by exact question match and
  says so in its README. Retrieval quality is out of scope (evals).
- *Scenario coverage:* one sweep over `Object.keys(builtinScenarios)` counts as covering every built-in scenario,
  because it does run each one through a real service.
- *Also covered beyond the list:* `streamWithInvokeModel` (InvokeModelWithResponseStream), `responses.stream()`,
  `onUnmatched: 'error'`, `times()`, `inject`, `replyEcho`, the `unmatched` / `fault` events, the `wire` record,
  per-step `delay`, scripted `usage`, the `models` option, and YAML `echo` / `lorem` / `json` / header routing.
- *Exemptions (25)* are listed with reasons in `examples/coverage.json`, for maintainer review.
- *0.2.0 was published* during this item (from the merged R17 work). Its CI post-publish verification passed with the
  `--prefer-online` fix, which was deferred from R16 and is now proven in CI.

### R20. Hosted playground on GitHub Pages
**Status:** Signed off: 2026-10-05
**Depends on:** none (waits for the item in progress)
**Goal:** anyone can browse the tutorial, see real runs and read the Reference at
https://andrewfooteqa.github.io/mock-llm/, linked from the README and npm, with nothing to host or operate.

**Decisions (maintainer, 2026-10-04):** GitHub Pages (static); lessons replay **recorded real runs**; the free-form
Playground gets a **"Run it live"** button that boots the real playground in the visitor's browser via **StackBlitz**;
the site is rebuilt and deployed **on each npm release**, from the release tag, so it documents the version users install.

**Acceptance criteria**

*One frontend, two modes*
- [x] All asset, fetch and docs URLs are relative (`styles.css`, `app.js`, `api/meta`, `api/run`, `docs/…`), so the
      same `playground/public` works at `/` locally and under `/mock-llm/` on Pages (evidence: local `npm run playground`
      unchanged; the subpath smoke test below)
      *(`index.html` uses `styles.css` / `app.js`; `transport.js` uses `api/meta`, `api/run`, `meta.json` and `recordings/…`; the Reference links use `docs/…`. `check.mjs` fails on any `href="/…"` in `app.js`. Locally, `npm run playground` and `playground:check` are unchanged (310 runs, 0 failures). The subpath smoke test passes. **Negative:** `/styles.css` → `HTTP 404: http://127.0.0.1:4318/styles.css` in the smoke test; reverted.)*
- [x] The frontend talks to a small transport layer: **live** (today's `/api/run` SSE and `/api/meta`) or **static**
      (recordings and `meta.json`). The static build selects it with a marker in `index.html`; no other code path differs
      *(`playground/public/transport.js`: `getMeta()` and `run(payload, onEvent)`, live (SSE) or static (replay), selected only by `<html data-mode="static">`, which `build.mjs` writes. `app.js` calls nothing else.)*

*Recordings*
- [x] `npm run playground:record` (reuses `check.mjs`'s enumeration and payload merge, `check.mjs:20-27`) writes one
      JSON file per lesson × variant × provider: the SSE events in order, each with its offset in ms, plus the
      request payload and the mock-llm version. It is generated at build time and not committed (no repo churn)
      *(`= node playground/check.mjs --record playground/.recordings`. It uses `enumerateRuns()` (`playground/public/runs.js`), shared with the page: each lesson × variant × provider, plus the Playground default form per provider. That's 310 files of `{ where, version, recordedAt, payload, events: [[ms, event, data]] }` (2.7 MB), keyed by a SHA-256 of the canonical payload. Generated at build time, gitignored. `npm run check` records during its normal check pass (no second run).)*
- [x] Replay feeds the same `onEvent` path as a live run, keeping the original timing (capped, e.g. ≤ 3 s per run), so
      streaming, the Events tab, Wire, Journal & cost and the App code tab all look like a live run. A small badge
      says "Recorded run · mock-llm vX.Y.Z"
      *(`transport.replay` calls the same `onEvent` with recorded offsets, scaled to fit 3 s (`MAX_REPLAY_MS`). The badge `Recorded run · mock-llm v0.2.0` shows in the status line (smoke test and screenshot).)*
- [x] `expectError` variants replay the SDK error exactly as recorded; lessons with `allowUnmatched` keep their events
      *(Events are stored verbatim, including the `error` event and every `mockevent` (so `unmatched` too). The smoke test asserts each lesson ends in the expected state (`data-status` ok / error).)*
- [x] `check.mjs` fails if any lesson × variant × provider has no recording after `playground:record` (no silent gaps)
      *(After `--record`, every `enumerateRuns()` key must exist (`<where>: no recording`). `tests/unit/playground-runs.test.ts` checks that all 310 keys are distinct and that equal payloads get equal keys.)*

*Static build*
- [x] `npm run playground:build` writes `site/` (gitignored):
      - `playground/public/*`
      - `meta.json`, generated from the same library exports `/api/meta` uses (`server.mjs:18`)
      - the README, ROADMAP, CHANGELOG, RELEASING and CONTRIBUTING files under `docs/`
      - all recordings
      - `.nojekyll`
      *(`playground/build.mjs`: public files, `meta.json` from `buildMeta()` (shared with `/api/meta` via `playground/meta.mjs`), `docs/` (5 files), `recordings/`, `.nojekyll`, the screenshot, and the version and static marker on `<html>`. `site/` and `playground/.recordings` are gitignored.)*
- [x] Reference page fault, edge-case and scenario lists render from `meta.json`; `/docs/*.md` links resolve
      *(The smoke test checks every fault and scenario name from `meta.json` on the Reference page, and that every `docs/…` link returns 200.)*
- [x] Inputs that can't be precomputed are clearly handled. The free-form Playground page and the `files` lesson's
      editor show the default recording read-only, plus the "Run it live" button and `npm run playground` instructions.
      Provider and variant switching still works from recordings
      *(The Playground form is disabled except the provider (each provider's default run is recorded). The `files` lesson's YAML is `readonly`. Both show a note with **Run it locally** and the `npm run playground` command. An unrecorded payload gives a "Not recorded" error (`NoRecordingError`). Covered by the smoke test.)*

*Run it live (StackBlitz)*
- [x] Spike first, findings recorded as an amendment:
      - Boot the repo's playground in StackBlitz WebContainers (`.stackblitzrc` / `startScript`, pinned to the release
        tag).
      - Report boot time, install size, and which providers work.
      - **Risk:** Bedrock's SDK needs HTTP/2 (h2c on the mock's single port), which WebContainers may not support.
      *(See the amendments: StackBlitz boots and builds in about 20 s, but mock-llm's server crashes there.)*
- [x] "Run it live" opens StackBlitz at the release tag, starting `npm run playground`. Any provider that doesn't work
      in WebContainers shows a clear in-app message there, not a hang. If the whole approach fails the spike, the
      button falls back to "run locally" instructions and this is recorded as an amendment
      *(**The spike failed**, so per this criterion the button falls back to **Run it locally**: a link to the repo at the release tag, plus the clone / install / `npm run playground` command. The smoke test asserts the link and the command.)*
- [x] Installing in StackBlitz doesn't download Playwright browsers or run other heavy postinstall steps (evidence: boot log)
      *(Spike boot log: `npm install` finished ("66 packages are looking for funding"), then `npm run build` and `mock-llm playground → http://localhost:4317`, about 20 s in all, with no browser download (`@playwright/test` doesn't download on install). Moot after the fallback.)*

*Deploy*
- [x] `release.yml`: when `steps.changesets.outputs.published == 'true'`, a `pages` job checks out the new tag,
      builds `site/`, and deploys with `actions/upload-pages-artifact` + `actions/deploy-pages` (permissions
      `pages: write`, `id-token: write`). A `workflow_dispatch` trigger allows a manual redeploy of the latest tag
      *(`pages.yml` (workflow_dispatch, `ref` = a tag or branch, default the latest `v*`) builds `site/`, smoke-tests it and deploys (`upload-pages-artifact` + `deploy-pages`, `pages: write`, `id-token: write`). `release.yml` gets `actions: write` and, after a publish, runs `gh workflow run pages.yml -f ref=v<version>`. Manual deploys work: runs 37295336769 and 37295944435 from `main`. **Release-triggered deploy proven by 0.2.1:** release run 37297442774 published 0.2.1, ran `verify:published`, and dispatched Pages run 37298135253 (`workflow_dispatch`, log `Building v0.2.1`, `HEAD is now at 360a9f7`). The live site serves `<html … data-version="0.2.1">`.)*
- [x] A failed Pages deploy is reported but never marks the npm release as failed
      *(The deploy is a separate workflow run (dispatched, not a job of the release run), and the dispatch step has `continue-on-error: true`.)*
- [x] Maintainer actions listed: enable Pages with source "GitHub Actions"; set the repo "About" website to the Pages URL
      *(RELEASING › Repository settings. Done by the maintainer on 2026-10-05: `gh api …/pages` → `build_type: workflow`; the repo homepage is the Pages URL.)*

*Verification*
- [x] Playwright (Chromium, already in CI) smoke test serves `site/` under `/mock-llm/` and checks:
      - every lesson opens and a recording plays to `done`
      - provider switching works
      - the Reference page lists the faults from `meta.json`
      - **no request goes to `api/*`**, and the console shows no errors
      *(`playground/site.spec.mjs` (20 tests) via `serve-site.mjs` under `/mock-llm/` (404 for `api/*`): every lesson plays to the end; provider and variant switching; the Playground per provider; the Reference page from `meta.json` plus docs links; read-only and "Run it locally"; console errors, page errors, 4xx/5xx responses and any `api/` request all fail a test. `npm run test:site` runs in `npm run check` after `playground:check`. Negative check: above.)*

      It runs in `npm run check` (after `playground:check`). Negative check: break one root-absolute path, and the test fails
- [x] First deploy verified: the Pages URL loads, and its lessons, Reference and "Run it live" all work (evidence: URL +
      deploy run link)
      *(https://andrewfooteqa.github.io/mock-llm/ was deployed by Pages runs 37295336769 and 37295944435. **The smoke test against the live URL** (`SITE_URL=https://andrewfooteqa.github.io/mock-llm/`): 20 passed (lessons, Reference, Playground, "Run it locally").)*

*Discoverability*
- [x] README: a "Docs & live playground" link to the Pages site near the top, plus a screenshot or GIF of a lesson run
      (served from Pages via an absolute URL, so it renders on npmjs.com too). `package.json` `homepage` is the Pages
      URL, so npm's sidebar links to it
      *(A README link near the top, and the screenshot `https://andrewfooteqa.github.io/mock-llm/screenshot.png` (absolute; produced by the smoke test during the deploy) linking to the agent-loop lesson. `package.json` `homepage` is the Pages URL.)*
- [x] README links render correctly on the npm package page (relative repo links become absolute where npm wouldn't
      resolve them) (evidence: checked on npmjs.com after the release)
      *(Checked in a browser on npmjs.com/package/mock-llm (0.2.1): the "Docs & live playground →" link points at the Pages URL; the screenshot renders (proxied through camo); the sidebar Homepage is the Pages URL. All 71 README links are absolute: npm rewrites relative ones to `github.com/AndrewFooteQA/mock-llm/blob/HEAD/<path>`. Checking the 19 repo paths found one **stale link**, `examples/claude-code.mjs` (from before the example became `examples/claude-code-cli`). It's fixed, and `tests/unit/docs-links.test.ts` now fails on any relative link in the README files, CONTRIBUTING, RELEASING or CHANGELOG that points at a missing file (negative check: reintroducing it fails). The npm page picks up the fixed README at the next release.)*
- [x] Standard criteria: tests · README + Reference page ("where to find this online") · `CLAUDE.md` Layout and
      definition of done (recordings and the static smoke test are part of `npm run check`) · `RELEASING.md` (Pages
      deploy step) · `npm run check`
      *(Tests: `site.spec.mjs` (20), `tests/unit/playground-runs.test.ts` (4), `check.mjs` recording plus gap check. Docs: README (the Docs section, lesson count 14 → 17), the Reference "Where to find this online" section, CLAUDE.md (Layout, the relative-URL rule, the static site in check), RELEASING (the Pages step plus settings). `npm run check` green (275 tests, 310 recorded runs, 20 site tests, 9/9 examples, coverage gate). CI 37296922179 and Release 37296922260 green on `3b24ac8`.)*

**Out of this item (on purpose):** running mock-llm itself in the browser (it needs Node's `http`/`http2`); a custom
domain; versioned docs per release (only the latest release is published).

**Amendments:**
- *StackBlitz spike (2026-10-05):*
  - `stackblitz.com/github/AndrewFooteQA/mock-llm?startScript=playground` boots in about 20 s. `npm install` and `npm run
    build` work: TypeScript 7's `tsc` ran there, despite the native-binary concern. The `/tree/<ref>` form hung at
    "Cloning repo from GitHub" for over 70 s, twice.
  - **But the mock can't serve a request in WebContainers.** On the first SDK call the server crashes in
    `socketOnData` (Node v22.22.3 emulation). The run showed "Success · 0 HTTP requests" with no reply.
  - Cause (from the stack and `src/mock.ts:285-294`): to serve HTTP/1.1 and h2c on one port, the mock sniffs the
    first bytes on a raw `net` server and hands the socket to an `http` / `http2` server
    (`socket.unshift` + `emit('connection')`), which WebContainers' socket emulation doesn't support.
  - Bedrock needs HTTP/2 regardless. An HTTP/1.1-only "WebContainer mode" would be a library change, and is a
    candidate future item; it isn't in R20.
  - The button therefore falls back to **Run it locally**, as this item allows.
- *Recording keys are payload hashes,* so the static site needs no lookup table and an edited scenario simply isn't
  found (a clear "Not recorded" message).
- *The Playground page's default form is recorded per provider* (5 more runs: 310 in total). The form is read-only on
  the hosted site except the provider.
- *Pages builds from a tag or branch.* Existing tags predate this code, so the first deploys were from `main`; release
  deploys use the new tag.
- *Found during the spike, fixed:* the frontend marked a run whose event stream ended without `done` (a server crash)
  as "Success". It now shows "The run ended unexpectedly".

---

### R21. Gemini continuation tokens (resumable generation)
**Status:** Proposed (from the SDK update playbook, Renovate PR #8: `@google/genai` 2.26.0)
**Depends on:** none
**Goal:** apps that resume long Gemini generations can test that path: the model stops with
`finishReason: CONTINUATION` and an opaque `continuationToken`, and the app sends `config.continuationToken` to continue.

**Draft acceptance criteria** (to be agreed before work starts)
- [ ] A reply can end in continuation: e.g. `reply(text, { stopReason: 'continuation' })`, the IR stop reason maps to
      Gemini's `CONTINUATION` with a deterministic base64 `continuationToken` (seeded), streaming and non-streaming
- [ ] A matcher for resume requests (e.g. `when({ continuationToken: true | string })`), plus YAML support
- [ ] Other providers: documented as Gemini-only (no equivalent wire field), so the stop reason falls back to `max_tokens` there
- [ ] Contract tests through `@google/genai` ≥ 2.26.0, gated with `sdkAtLeast` for the matrix floor
- [ ] Standard criteria: README + playground lesson variant + an example use (the coverage gate will require one)

**Amendments:** none

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
