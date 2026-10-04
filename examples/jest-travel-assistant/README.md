# Example: Jest + OpenAI Responses API travel assistant

A travel assistant built on the OpenAI **Responses API** (tool loop through `previous_response_id`, conversation memory),
tested with **Jest** and `mock-llm/jest`. It shows how to:

- use `useMockLLM({ strict: true })` from `mock-llm/jest`, so an unscripted LLM call fails the test even though the app hides API errors
- assert with the same matchers as Vitest: `toHaveRequestedTool`, `toHaveReturnedToolResult`, `toHaveToolTrajectory`, `toHaveReceivedRequest(Times)`, `toHaveReceivedPrompt`, `toHaveNoUnmatchedRequests`
- script multi-tool trajectories and check that conversation memory (`previous_response_id`) reaches the model
- test refusals and 429 retries

```sh
npm install
npm test
```

## Jest setup (ESM)

mock-llm is published as an ES module, so Jest must run in ESM mode. This example uses the minimum setup:

```jsonc
// package.json
"type": "module",
"scripts": { "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js" },
"jest": { "testEnvironment": "node", "transform": {}, "testMatch": ["**/test/**/*.test.mjs"] }
```

`testMatch` is only needed for `.mjs` test files on Jest 29: Jest 30's default pattern includes `.mjs`, Jest 29's doesn't.

Import Jest's APIs from `@jest/globals`. For TypeScript tests, keep your existing transform (ts-jest, babel or swc)
configured for ESM; mock-llm ships its own types for the matchers.

| File | What it is |
|---|---|
| `src/assistant.mjs` | The app. It contains nothing mock-specific. |
| `test/assistant.test.mjs` | Jest tests |
