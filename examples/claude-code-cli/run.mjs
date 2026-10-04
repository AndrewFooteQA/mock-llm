// Run the real Claude Code CLI against mock-llm, so no tokens are spent.
//   npm start          → print Claude Code's output and the requests the mock saw
//   npm test           → same, but assert on the result (skips if `claude` isn't installed)
import { spawn, spawnSync } from 'node:child_process';
import { createMockLLM } from 'mock-llm';

const check = process.argv.includes('--check');
if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).error) {
  console.log('Claude Code CLI (`claude`) not found on PATH; skipping. Install: https://claude.com/claude-code');
  process.exit(0);
}

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
  const ok = code === 0 && out.includes(REPLY) && messages.length > 0 && messages.every((e) => e.status === 200);
  console.log(ok ? '\n✔ Claude Code completed a session against mock-llm' : '\n✘ unexpected result');
  process.exit(ok ? 0 : 1);
}
