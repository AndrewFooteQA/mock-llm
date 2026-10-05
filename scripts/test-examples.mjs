// Build mock-llm, install a fresh packed copy into every examples/* project, and run its tests.
//   npm run test:examples            → all examples
//   npm run test:examples -- gemini  → examples whose directory name contains "gemini"
// Outcomes: ✔ passed, ✘ failed, ⊘ skipped (the example exited 77). Skips fail the run when CI=true.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv[2];
const status = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status;
const run = (cmd, args, cwd) => status(cmd, args, cwd) === 0;
/** An example's `npm test` exits 77 when it can't run here (e.g. a CLI it drives isn't installed). */
const SKIPPED = 77;
const ci = /^(1|true)$/i.test(process.env.CI ?? '');

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
  const code = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir) ? status('npm', ['test'], dir) : 1;
  results.push([name, code === 0 ? 'passed' : code === SKIPPED ? 'skipped' : 'failed']);
}

const MARK = { passed: '✔', failed: '✘', skipped: '⊘' };
console.log('\nExamples:');
for (const [name, outcome] of results) console.log(`  ${MARK[outcome]} ${name}${outcome === 'skipped' ? ' (skipped: see its output above)' : ''}`);
const skipped = results.filter(([, o]) => o === 'skipped');
if (skipped.length && ci) console.log(`\n✘ ${skipped.length} example(s) skipped, which is not allowed in CI (CI=true): install what they need.`);
process.exit(results.some(([, o]) => o === 'failed') || (ci && skipped.length) ? 1 : 0);
