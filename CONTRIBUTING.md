# Contributing to mock-llm

Thanks for helping. mock-llm is a **library used inside test frameworks**, not a test runner, reporter or eval tool.
Read the [scope section](README.md#scope-what-mock-llm-is-not) before proposing a feature.

## Setup

```sh
npm install
npm run build
(cd examples/playwright-chat-ui && npm install && npx playwright install chromium)   # once, for the Playwright example
```

Node ≥ 22.

## Definition of done

Every change ships with:

1. **Tests.** Unit tests in `tests/unit`, plus contract tests in `tests/contract` for anything provider-facing. Contract
   tests use the provider's official SDK against the mock.
2. **Docs.** Update the README section and the playground lesson or Reference page (`playground/public`).
3. **Examples.** Update or add a project in `examples/` when the change affects how people use the library.
4. **A changeset.** Run `npx changeset`, pick `patch` / `minor`, and describe the change for users.
   Docs-only or internal changes use `npx changeset --empty`.
5. **`npm run check` green.** This runs typecheck, tests, every playground lesson and every example. CI runs the same.

`npm run pack:check` verifies the published package's contents and installs the packed tarball into a clean project.

## Pull requests

- Dependency updates come from Renovate. Handle them with the SDK update playbook in
  [`CLAUDE.md`](CLAUDE.md#sdk-updates-dependency-prs).

- CI must pass: tests on Node 22/24/26, the full check, the package check, and a changeset present.
- Larger features go through [`ROADMAP.md`](ROADMAP.md): acceptance criteria are agreed first, and the item is signed off
  by the maintainer before the next one starts.
- Adding a provider: implement the `Adapter` interface in `src/providers/adapter.ts` and add contract tests that use the
  provider's official SDK.

## Releases

Maintainers only, from CI. See [`RELEASING.md`](RELEASING.md).
