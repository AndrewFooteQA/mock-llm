# Example: OpenAI support bot (Vitest)

A customer-support bot built on the official `openai` SDK, tested with mock-llm. It shows how to:

- point the SDK at the mock (`baseURL: mock.urls.openai`)
- script replies with matchers
- test **refusals**, **truncation**, **prompt-injection output**, **429 retries**, **outages** and **timeouts**
- run under **seeded chaos**, both errors and **content chaos** (refusals, empty and truncated answers), and put `mock.seed` in assertion messages so a failure can be replayed with `MOCK_LLM_SEED`
- simulate the model's **context window** (`contextWindow`) and handle `context_length_exceeded` with a "please shorten" reply
- run in **strict mode** (`useMockLLM({ strict: true })`), so an LLM call no test scripted fails the test even though the bot hides API errors from users
- assert on what the app *sent* with mock-llm's matchers (`toHaveReceivedRequest`, `toHaveReceivedPrompt`, `toHaveUsedTokensLessThan`)

```sh
npm install
npm test
```

| File | What it is |
|---|---|
| `src/bot.ts` | The app code. It contains nothing mock-specific. |
| `test/bot.test.ts` | Tests using `useMockLLM()` from `mock-llm/vitest` |

> This example installs mock-llm from the repo (`file:../..`). In your own project, use `npm install -D mock-llm`.
