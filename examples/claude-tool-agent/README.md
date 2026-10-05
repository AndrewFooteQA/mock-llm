# Example: Claude tool-using agent (Vitest)

A manual tool-use loop on the official `@anthropic-ai/sdk`, tested with mock-llm. It shows how to:

- script multi-turn agent conversations (`replyToolCall(...).then.reply(...)`, or route with `{ hasToolResult: true }`)
- test **parallel tool calls**, **hallucinated tools**, **wrong argument types**, **runaway loops** and **refusals**
- assert on what your agent did with `toHaveReturnedToolResult`, `toHaveRequestedTool` and `toHaveToolTrajectory`
- route on model family and toolset with `when({ model: 'claude-*', tools: [...] })`, and on the conversation's shape
  (`system`, `turn`, `hasTools`, `stream`, `anyMessage`, or a `where` predicate)
- **stream** every turn with `messages.stream()` (`stream: true`), including a tool-use turn whose input arrives in pieces
- keep **reasoning** (`reply(text, { thinking })`) out of the answer while logging it; the agent asks for adaptive thinking
- test **malformed tool arguments** and **schema-generated tool input** (`replyToolCallFromSchema`), and check the tools
  offered (`toHaveOfferedTool`)

```sh
npm install
npm test        # tsc --noEmit (strict, against mock-llm's published types), then vitest
```

| File | What it is |
|---|---|
| `src/agent.ts` | The agent loop. It contains nothing mock-specific. |
| `src/tools.ts` | Tools with input validation |
| `test/agent.test.ts` | Tests |

The same code works with Claude Code's API surface: Claude Code reaches the mock through `ANTHROPIC_BASE_URL` (see `../claude-code-cli`).
