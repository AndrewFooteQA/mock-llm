# mock-llm: instructions for Claude

mock-llm is an open-source (MIT) TypeScript library that impersonates LLM provider APIs (OpenAI Chat + Responses,
Anthropic Messages, Gemini, Bedrock) closely enough that apps can test against it with the **official SDKs unchanged**.
Users rely on it to behave like the real APIs, so fidelity is the product.

## Roadmap workflow (feature work)

Feature work follows [`ROADMAP.md`](ROADMAP.md), whose sign-off workflow is binding:

- Work on **one** roadmap item at a time. Before starting, restate its acceptance criteria and set it `In progress`.
  Don't start an item while another is `In progress` or `Ready for sign-off`.
- Tick a criterion only with evidence (test name, command output, lesson or example path), written next to the tick.
- When every criterion is ticked, set `Ready for sign-off`, post a sign-off summary (criterion → evidence, plus
  anything deferred and why), then **stop and wait**. Never mark an item `Signed off` yourself; only the maintainer does.
- On "signed off", record `Signed off: <date>`; on "changes requested", record them under the item and resume.
- Ideas or gaps found mid-item become new roadmap items or recorded amendments, not unplanned additions. Never
  re-propose anything in the roadmap's "Out of scope" table without the maintainer asking.
- Bug fixes and small maintenance outside the roadmap still follow the definition of done below.

## Definition of done (every change)

A change is not finished until all three parts are done, **in the same change**:

1. **Tests**
   - New behaviour gets tests. Every bug fix gets a regression test that fails without the fix.
   - Anything that affects wire format gets a **contract test** in `tests/contract/` that calls the mock through that
     provider's official SDK and asserts on what the SDK returns or throws. Asserting on raw JSON is not enough.
   - Library-internal logic (rules, schema faker, scenario files, journal) gets unit tests in `tests/unit/`.

2. **Docs & tutorial**
   - `README.md`: any user-facing API, option, fault, edge case, scenario or provider behaviour.
   - Playground (`playground/`), the live docs site:
     - `public/lessons.js`: add or extend a lesson or variant when a feature is something users *do*. Mark
       variants that are meant to end in an SDK error with `expectError: true`. Lesson rules must script every
       request: `playground:check` fails on unscripted (unmatched) requests unless a variant sets
       `allowUnmatched: true` (or a list of providers) because falling through is the point of the lesson.
     - `public/app.js`, Reference page: options, matchers, responders, `FAULT_DOCS`, `EDGE_DOCS`, endpoints, examples.
       Fault, edge-case and scenario *names* come from `/api/meta`, but their descriptions are hand-written. Add one.
     - `server.mjs`: provider drivers, if a provider or SDK call shape changes.
   - JSDoc on exported functions and options.

3. **Examples** (`examples/`)
   - Update every example that uses changed behaviour. If a change affects an API an example calls, the example
     must still pass.
   - A new provider, or a major feature that existing examples don't cover, gets a new standalone example project.
     Copy the shape of the existing ones and add it to `examples/README.md`, the README "Example projects" section,
     and the Reference page's example table.
   - Example app code (`src/`) must contain **nothing mock-specific**. Only the tests know about mock-llm.
   - **Keep the three example indexes in sync.** When an example gains or loses a feature (a matcher, strict mode, events,
     …), update its row in all of: `examples/README.md` (full feature list), the root README "Example projects" table,
     and the Reference page's example table in `playground/public/app.js`. Write rows from what the example actually uses
     (`npm run coverage:examples -- --by-example` lists it), not from intent.
   - **Every feature has an example or a recorded exemption.** `npm run coverage:examples` builds the feature inventory
     from the source (exports, faults, edge cases, built-in scenarios, matchers, rule methods, options, matcher keys,
     scenario-file steps, events), plus the provider SDK calls in `examples/coverage.json`. `npm run check` fails when
     something is used by no example and isn't exempt. A new export, fault, matcher or option therefore needs an example
     use, or an entry in `exempt` with a one-line reason (internal helpers only; the maintainer reviews exemptions).
   - TypeScript examples type-check (`tsc --noEmit`, `strict`) before their tests: never silence a type error with
     `as any` / `as never` in an example. Users copy them.
   - An example that can't run in an environment (e.g. it needs a CLI) exits **77** to report ⊘ skipped, never 0.
     `test:examples` fails on skips in CI.

4. **Changeset** (`.changeset/`)
   - Any change to what ships (`src/`, `package.json` exports/peers/engines) gets a changeset: run
     `npx changeset --empty` and then edit the file, or write `.changeset/<name>.md` by hand with
     `---\n"mock-llm": patch|minor\n---` and a user-facing description.
   - On 0.x, breaking changes are `minor` and need a migration note. See `RELEASING.md`.
   - Never run `npm publish`, `changeset publish` or `changeset version` locally. Releases happen only in CI.

Then run the full check and report the results honestly, including anything skipped:

```sh
npm run check   # typecheck + library tests + playground:check + test:examples
```

Individual pieces: `npm test`, `npm run typecheck`, `npm run playground:check` (every lesson × variant × provider),
`npm run test:examples [-- <name-filter>]`.

**This is enforced by a Stop hook** (`.claude/settings.json` → `scripts/claude-stop-check.mjs`). When you finish a turn
in which project files changed, it runs `npm run check` and blocks you from stopping if it fails. If `src/` changed with
no test changes, or no README or playground changes, it blocks once more with a reminder. Act on it, or explicitly say
why the change needs none. If the check is still failing and you have no further fix, stop and tell the user what's
failing. The hook won't loop. Nothing is re-run when no files changed since the last passing check.

## SDK updates (dependency PRs)

Renovate opens one PR per ecosystem (`renovate.json`). On a provider SDK PR, the **SDK surface diff** comment lists what
changed in the SDK's types (stream events, content blocks, parameters, endpoints, errors). The **full compatibility
matrix** runs (`.github/workflows/compat.yml`). Work through every SDK, test-framework or TypeScript update like this,
and record the decision in a PR comment:

1. **Read** the surface diff comment, the release notes in the PR body, and any failing matrix job.
2. **Classify** the update as one or more of:
   - **No impact.** Nothing in the diff touches what the mock renders or parses, and the matrix is green. Merge.
   - **Breaking.** The SDK now expects something the mock doesn't send, or sends something the mock can't parse: a
     failing contract test, a new required field, a renamed event, a changed error class. Fix it **in the same PR**,
     following the definition of done: a contract test through that SDK, then docs and examples. If older SDK
     releases still in range behave differently, gate only the SDK-side assertion with `sdkAtLeast()`
     (`tests/helpers/sdk-version.ts`). Never gate an assertion about what the mock sends.
   - **New feature to support.** The API gained something users will want to test (a content-block type, a stream event,
     an endpoint, a parameter that changes responses). Don't build it in the dependency PR. Add a roadmap item with
     acceptance criteria and link it from the PR. Merge the update if nothing is broken.
   - **Deprecation.** Something the mock implements is deprecated. Note it in the PR. When the SDK removes it, the
     mock keeps serving it for as long as older SDK releases in the supported range use it.
3. **Floors.** If an older release in the supported range can no longer work (e.g. the mock needs a newer error class),
   raise its `oldest` in `compat/targets.json` with the reason in `floor`. That's a `minor` changeset. Peer ranges in
   `package.json` follow the tested floors of Vitest, Jest, Playwright and yaml.
4. **Record** the classification and links (roadmap item, fix commit) in a PR comment before merging.

Never guess wire formats from the diff alone. Read the SDK's source in `node_modules` (see Rules of the road).

The matrix can be run locally: `npm run compat -- run <target> <oldest|latest|x.y.z>` (targets in
`compat/targets.json`), or `npm run compat -- run-all-latest`. Each run works in a temporary copy of the repo, and runs
examples outside the repo against the packed tarball.

## Layout

```
src/core/          IR types, rule engine, responders, faults, edge cases, scenarios, schema faker, journal, pricing
src/providers/     one adapter per provider (parse → IR, render IR → wire, native errors); eventstream.ts = AWS framing
src/mock.ts        server (HTTP/1.1 + h2c on one port), routing, rule resolution, faults, wire recording
src/assert/        framework-agnostic assertions over the journal ({ pass, message }); adapters wrap these
src/testing/       mock-llm/vitest + mock-llm/jest adapters (lifecycle + matcher registration via shared matchers.ts;
                   never shadow built-in toHaveBeenCalled*). Jest needs ESM mode; adapter tests run Jest on dist/.
                   mock-llm/playwright: shared mock via startMockLLM (globalSetup) + RemoteMockLLM (src/remote.ts) over
                   the /__mock/* control API; async matchers; proven in examples/playwright-chat-ui (Chromium)
tests/unit|contract  library tests (vitest.config.ts restricts the root run to tests/)
playground/        docs + live tutorial (server.mjs, public/*, check.mjs)
examples/          standalone starter projects, each with its own package.json and tests
scripts/           repo tooling: test-examples, example-coverage, pack checks, verify-published, compat (matrix),
                   sdk-surface-diff, needs-changeset
compat/            targets.json (supported ranges + floors), results.json (last matrix results → README table)
```

## Rules of the road

- **Never guess wire formats.** Before adding or changing provider behaviour, read the official SDK's source in
  `node_modules` (streaming parsers, error classes, retry logic) and match what it expects. Past examples: Bedrock's
  SDK forces HTTP/2, Gemini sends mid-stream errors as bare JSON, the OpenAI SDK defaults embeddings to base64, and
  Claude Code sends `role: "system"` messages.
- **Errors must be native.** A fault has to produce the provider's real status code, error envelope and headers, so the
  SDK raises its real exception class and runs its real retry logic.
- **Zero runtime dependencies** in the library (`yaml` and `vitest` are optional peers). The SDKs are dev
  dependencies, used only for tests, examples and the playground.
- **Deterministic by default:** use the seeded `Rng`, never `Math.random()`. Latency is off unless configured.
- **Don't ship guessed prices.** `DEFAULT_PRICING` contains only verified Anthropic list prices (with the as-of date). Other
  providers' prices are user-supplied.
- **The IR is the contract between adapters and rules.** Keep it provider-neutral. Provider-specific details go in
  `IRRequest.raw` or in the adapter.
- **Rule precedence is "latest matching rule wins".** Keep docs, examples and tests consistent with it.
- Match the surrounding code style (comment density, naming). Keep the README and playground wording in step.
- Don't commit, push or publish unless asked.
