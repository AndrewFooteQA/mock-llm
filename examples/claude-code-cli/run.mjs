// Run the real Claude Code CLI against mock-llm, so no tokens are spent.
//   npm start          → print Claude Code's output and the requests the mock saw
//   npm test           → same, but assert on the result
// Without the `claude` CLI on PATH it exits 77, the conventional "skipped" code: test runners (and this repo's
// `npm run test:examples`) report a skip instead of a pass. Install: npm install -g @anthropic-ai/claude-code
import { spawn, spawnSync } from 'node:child_process';
import { createMockLLM, toHaveReceivedPrompt, toHaveReceivedRequest } from 'mock-llm';

const SKIPPED = 77;
const check = process.argv.includes('--check');
const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (version.error) {
  console.log('Claude Code CLI (`claude`) not found on PATH; skipping. Install: npm install -g @anthropic-ai/claude-code');
  process.exit(SKIPPED);
}
console.log(`Claude Code ${version.stdout.trim()}`);

const REPLY = 'Hello from mock-llm! No tokens were spent.';
const mock = await createMockLLM();
mock.default().reply(REPLY);

// mock.env() sets ANTHROPIC_BASE_URL + a dummy ANTHROPIC_API_KEY (plus the other providers' vars).
const env = { ...process.env, ...mock.env() };
delete env.CLAUDE_CODE_OAUTH_TOKEN; // make sure the API-key + base-URL path is used

const child = spawn('claude', ['-p', 'say hi', '--bare'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  if (!check) process.stdout.write(d);
});
const [code] = await new Promise((resolve) => child.on('exit', (...args) => resolve(args)));

const messages = mock.journal.all({ endpoint: 'chat' });
console.log(`\nclaude exited ${code}; requests seen by the mock:`);
for (const e of mock.journal.all()) console.log(`  ${e.method} ${e.path} -> ${e.status} (${e.matchedBy ?? 'built-in'})`);
await mock.stop();

if (check) {
  // Assert on what Claude Code actually sent, with the same framework-agnostic assertions the matchers use.
  const checks = [
    ['claude exited 0', code === 0],
    ['printed the scripted reply', out.includes(REPLY)],
    ['every Messages request succeeded', messages.length > 0 && messages.every((e) => e.status === 200)],
    ['sent the prompt "say hi" as the user message', toHaveReceivedPrompt(mock, 'say hi', { in: 'user' }).pass],
    ['used a Claude model on the Anthropic API', toHaveReceivedRequest(mock, { provider: 'anthropic', model: /claude/ }).pass],
  ];
  for (const [name, pass] of checks) console.log(`  ${pass ? '✔' : '✘'} ${name}`);
  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? '\n✔ Claude Code completed a session against mock-llm' : '\n✘ unexpected result');
  process.exit(ok ? 0 : 1);
}
