# Example: Claude tool-using agent (Vitest)

A manual tool-use loop on the official `@anthropic-ai/sdk`, tested with mock-llm. It shows how to:

- script multi-turn agent conversations (`replyToolCall(...).then.reply(...)`, or route with `{ hasToolResult: true }`)
- test **parallel tool calls**, **hallucinated tools**, **wrong argument types**, **runaway loops** and **refusals**
- assert on what your agent did with `toHaveReturnedToolResult`, `toHaveRequestedTool` and `toHaveToolTrajectory`
- route on model family and toolset with `when({ model: 'claude-*', tools: [...] })`

```sh
npm install
npm test
```

| File | What it is |
|---|---|
| `src/agent.ts` | The agent loop. It contains nothing mock-specific. |
| `src/tools.ts` | Tools with input validation |
| `test/agent.test.ts` | Tests |

The same code works with Claude Code's API surface: Claude Code reaches the mock through `ANTHROPIC_BASE_URL` (see `../claude-code-cli`).
