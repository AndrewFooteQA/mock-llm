# Example: Claude Code CLI against mock-llm

Runs the real **Claude Code** CLI with `ANTHROPIC_BASE_URL` pointed at mock-llm. Use this pattern to test anything that
shells out to Claude Code (CI bots, scripts, agent harnesses) without spending tokens.

```sh
npm install
npm start      # show Claude Code's output and the requests the mock received
npm test       # assert it completed (skips if `claude` isn't installed)
```

The same pattern works for any process: spread `mock.env()` into the child's environment.
