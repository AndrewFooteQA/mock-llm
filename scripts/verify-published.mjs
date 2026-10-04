// After a release: install the *published* mock-llm into a copy of every example and run its tests.
//   node scripts/verify-published.mjs            → the version in package.json
//   node scripts/verify-published.mjs 0.2.0     → a specific version (or a dist-tag, e.g. next)
// Proves what users get from npm works, not just the local build. Retries the install while the
// registry propagates a version that was published moments ago.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'mock-llm-published-'));
const examples = readdirSync(join(root, 'examples'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'examples', d.name, 'package.json')))
  .map((d) => d.name);

const results = [];
for (const name of examples) {
  const dir = join(work, name);
  console.log(`\n━━ ${name} (mock-llm@${version} from npm) ━━`);
  cpSync(join(root, 'examples', name), dir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|test-results|playwright-report)$/.test(src) && !src.endsWith('package-lock.json'),
  });
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const deps of [pkg.dependencies, pkg.devDependencies]) if (deps?.['mock-llm']) deps['mock-llm'] = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  let installed = false;
  for (let attempt = 1; attempt <= 5 && !installed; attempt++) {
    installed = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir);
    if (!installed && attempt < 5) await sleep(attempt * 15_000);
  }
  results.push([name, installed && run('npm', ['test'], dir)]);
}
rmSync(work, { recursive: true, force: true });

console.log(`\nPublished mock-llm@${version} against the examples:`);
for (const [name, ok] of results) console.log(`  ${ok ? '✔' : '✘'} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
