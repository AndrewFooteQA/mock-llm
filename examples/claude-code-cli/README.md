# Example: Claude Code CLI against mock-llm

Runs the real **Claude Code** CLI with `ANTHROPIC_BASE_URL` pointed at mock-llm. Use this pattern to test anything that
shells out to Claude Code (CI bots, scripts, agent harnesses) without spending tokens.

```sh
npm install
npm start      # show Claude Code's output and the requests the mock received
npm test       # assert on what Claude Code sent and printed
```

`npm test` checks the session with mock-llm's assertions as plain functions: the prompt arrived as the user message, a
Claude model was used, and the scripted reply was printed. Without the `claude` CLI on PATH it exits **77**, the
conventional "skipped" code, so `npm run test:examples` reports ⊘ instead of a pass. CI installs the CLI
(`npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code`; npm 12 blocks the
postinstall that fetches the CLI's binary unless it's allowed), where a skip fails the run.

The same pattern works for any process: spread `mock.env()` into the child's environment.
