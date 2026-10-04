// Build mock-llm, install a fresh packed copy into every examples/* project, and run its tests.
//   npm run test:examples            → all examples
//   npm run test:examples -- gemini  → examples whose directory name contains "gemini"
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv[2];
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;

if (!run('npm', ['run', 'build'], root)) process.exit(1);

const examples = readdirSync(join(root, 'examples'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'examples', d.name, 'package.json')))
  .map((d) => d.name)
  .filter((name) => !filter || name.includes(filter));

const results = [];
for (const name of examples) {
  const dir = join(root, 'examples', name);
  console.log(`\n━━ ${name} ━━`);
  // Always reinstall mock-llm so the example tests the code you just changed.
  rmSync(join(dir, 'node_modules', 'mock-llm'), { recursive: true, force: true });
  const ok = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir) && run('npm', ['test'], dir);
  results.push([name, ok]);
}

console.log('\nExamples:');
for (const [name, ok] of results) console.log(`  ${ok ? '✔' : '✘'} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
