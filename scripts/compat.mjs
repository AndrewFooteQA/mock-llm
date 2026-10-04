// Compatibility matrix runner (ROADMAP R17). Proves which SDK / test-framework versions mock-llm works with.
//
//   node scripts/compat.mjs run <target> <oldest|latest|x.y.z> [--out file.json]
//       One target at one version: e.g. `run openai oldest`. Other dependencies stay at the lockfile versions.
//   node scripts/compat.mjs run-all-latest [--out file.json]
//       Every target at its newest release at once, plus every example project with its SDKs/frameworks at latest.
//   node scripts/compat.mjs report <dir-of-result-json>...
//       Merge result files into compat/results.json (the record the README table is generated from).
//   node scripts/compat.mjs plan <smoke|full>
//       The GitHub Actions matrix (JSON) for .github/workflows/compat.yml. smoke = oldest of each provider SDK on the
//       middle Node line (pull requests); full = every target at oldest and latest, plus everything-latest on every Node
//       line (weekly, and on Renovate PRs).
//   node scripts/compat.mjs node-check
//       Compare compat/targets.json "node" with Node's release schedule: every even-numbered line from its release to
//       its end of life. Fails (so the weekly job opens an issue) when a line should be added or dropped.
//   node scripts/compat.mjs lint
//       `readme --check`, plus: the CI workflow's Node matrix equals compat/targets.json "node". Part of `npm run check`.
//   node scripts/compat.mjs readme [--check]
//       Regenerate the README "Compatibility" table from compat/targets.json + compat/results.json
//       (`--check`: fail if the README is out of date; part of `npm run check`).
//
// Each run works in a temporary copy of the repo with its own node_modules, so it never changes your checkout.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TARGETS_FILE = join(root, 'compat/targets.json');
const RESULTS_FILE = join(root, 'compat/results.json');
const { targets } = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest.splice(i, 2)[1];
};

const sh = (cmd, args, cwd, env = {}) => {
  console.log(`  $ ${cmd} ${args.join(' ')}${cwd === root ? '' : `   (in ${cwd.replace(/^.*mock-llm-compat-[^/]+\/?/, '<copy>/') || '<copy>'})`}`);
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' }).status === 0;
};
const quiet = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
const npmInstall = (cwd, specs = []) =>
  sh('npm', [specs.length ? 'install' : 'ci', ...(specs.length ? ['--no-save'] : []), ...specs, '--no-audit', '--no-fund', '--loglevel=error'], cwd);
const installedVersion = (cwd, pkg) => JSON.parse(readFileSync(join(cwd, 'node_modules', pkg, 'package.json'), 'utf8')).version;

/** A throwaway copy of the working tree (tracked + untracked, minus ignored files). */
function workCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'mock-llm-compat-'));
  const files = quiet('git', ['ls-files', '-co', '--exclude-standard', '-z'], root).stdout.split('\0').filter(Boolean);
  for (const f of files) {
    if (!existsSync(join(root, f))) continue; // deleted but not yet staged
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(root, f), join(dir, f));
  }
  return dir;
}

/** Vitest run with a JSON report, so failures can be listed by name. */
function vitest(cwd) {
  const out = join(cwd, '.compat-vitest.json');
  const ok = sh('npx', ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile=${out}`], cwd);
  let failures = [];
  try {
    const report = JSON.parse(readFileSync(out, 'utf8'));
    failures = report.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
  } catch {
    if (!ok) failures = ['(no JSON report: vitest itself failed to run)'];
  }
  return { ok: ok && !failures.length, failures };
}

/**
 * Pin `specs` ({ name: version }) in an example's package.json and install from scratch (no lockfile), the way a user's
 * project resolves them. (`npm install --no-save` over a lockfile can mix a framework with its sibling packages from
 * another major, e.g. Vitest 4 with Vite from Vitest 5, which no real project would have.)
 */
function pinAndInstall(dir, specs) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const [name, version] of Object.entries(specs)) {
    const field = pkg.dependencies?.[name] ? 'dependencies' : 'devDependencies';
    (pkg[field] ??= {})[name] = version;
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  rmSync(join(dir, 'package-lock.json'), { force: true });
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  return sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir);
}

const exampleDirs = (cwd) =>
  readdirSync(join(cwd, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(cwd, 'examples', d.name, 'package.json')))
    .map((d) => join(cwd, 'examples', d.name));

/**
 * Copy an example out of the repo and point it at the packed tarball, as a user's project would be. Inside the repo,
 * tools that search parent directories for config (Vitest 4 does) would pick up the library's own config instead.
 */
function standalone(cwd, exampleDir) {
  const tgz = (standalone.tgz ??= new Map()).get(cwd) ?? (() => {
    const out = quiet('npm', ['pack', '--ignore-scripts', '--pack-destination', cwd], cwd).stdout.trim().split('\n').at(-1);
    standalone.tgz.set(cwd, join(cwd, out));
    return join(cwd, out);
  })();
  const dir = join(`${cwd}-examples`, exampleDir.split('/').at(-1));
  cpSync(exampleDir, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|test-results|playwright-report)$/.test(src) });
  rmSync(join(dir, '.npmrc'), { force: true }); // install-links only matters for file:../..
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) if (pkg[field]?.['mock-llm']) pkg[field]['mock-llm'] = `file:${tgz}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return dir;
}
const depsOf = (dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { ...pkg.dependencies, ...pkg.devDependencies };
};

/** Run one example with some of its dependencies pinned. */
function runExample(cwd, exampleDir, specs) {
  const name = `examples/${exampleDir.split('/').at(-1)}`;
  const dir = standalone(cwd, exampleDir);
  if (!pinAndInstall(dir, specs)) return { ok: false, failure: `${name}: install failed` };
  const browsers = !depsOf(dir)['@playwright/test'] || sh('npx', ['playwright', 'install', ...(process.env.CI ? ['--with-deps'] : []), 'chromium'], dir);
  return browsers && sh('npm', ['test'], dir) ? { ok: true, dir } : { ok: false, failure: name };
}

/** Test-framework targets: every example project that uses the framework, with the framework pinned. */
function frameworkExamples(cwd, t, version) {
  const dirs = exampleDirs(cwd).filter((dir) => t.packages.some((p) => depsOf(dir)[p]));
  if (!dirs.length) return { ok: false, failures: [`no example uses ${t.packages.join(' / ')}`], resolved: version };
  const failures = [];
  let resolved = version;
  for (const dir of dirs) {
    const r = runExample(cwd, dir, Object.fromEntries(t.packages.filter((p) => depsOf(dir)[p]).map((p) => [p, version])));
    if (!r.ok) failures.push(r.failure);
    else resolved = installedVersion(r.dir, t.packages[0]);
  }
  return { ok: !failures.length, failures, resolved, examples: dirs.map((d) => d.split('/').at(-1)) };
}

function typesCheck(cwd, version) {
  const tscDir = join(cwd, '.compat-tsc');
  mkdirSync(tscDir);
  writeFileSync(join(tscDir, 'package.json'), '{"private":true}');
  if (!npmInstall(tscDir, [`typescript@${version}`])) return { ok: false, failures: ['install failed'] };
  const ok = sh('node', ['scripts/smoke-pack.mjs'], cwd, { MOCK_LLM_TSC: join(tscDir, 'node_modules/typescript/bin/tsc') });
  return { ok, failures: ok ? [] : ['published .d.ts files do not type-check in a consumer project'], resolved: installedVersion(tscDir, 'typescript') };
}

function resolveVersion(target, spec) {
  if (spec === 'oldest') return targets[target].oldest;
  if (spec === 'latest') return quiet('npm', ['view', targets[target].packages[0], 'version'], root).stdout.trim();
  return spec;
}

function runOne(target, spec) {
  const t = targets[target];
  if (!t) throw new Error(`unknown target "${target}". Known: ${Object.keys(targets).join(', ')}`);
  const version = resolveVersion(target, spec);
  console.log(`\n━━ ${target}@${version} (${spec}) on Node ${process.versions.node} ━━`);
  const cwd = workCopy();
  try {
    if (!npmInstall(cwd) || !sh('npm', ['run', 'build'], cwd)) return { ok: false, failures: ['setup failed'], resolved: version };
    if (t.kind === 'framework' || t.kind === 'playwright') return frameworkExamples(cwd, t, version);
    if (t.kind === 'types') return typesCheck(cwd, version);
    if (!npmInstall(cwd, t.packages.map((p) => `${p}@${version}`))) return { ok: false, failures: ['install failed'], resolved: version };
    return { ...vitest(cwd), resolved: installedVersion(cwd, t.packages[0]) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(`${cwd}-examples`, { recursive: true, force: true });
  }
}

function runAllLatest() {
  console.log(`\n━━ everything at latest on Node ${process.versions.node} ━━`);
  const cwd = workCopy();
  const failures = [];
  const resolved = {};
  try {
    const specs = Object.values(targets).filter((t) => t.kind !== 'types' && t.kind !== 'playwright').flatMap((t) => t.packages.map((p) => `${p}@latest`));
    if (!npmInstall(cwd) || !npmInstall(cwd, specs) || !sh('npm', ['run', 'build'], cwd)) return { ok: false, failures: ['setup failed'], resolved };
    for (const t of Object.values(targets)) if (t.kind !== 'types' && t.kind !== 'playwright') resolved[t.packages[0]] = installedVersion(cwd, t.packages[0]);
    failures.push(...vitest(cwd).failures);
    const types = typesCheck(cwd, 'latest');
    resolved.typescript = types.resolved;
    failures.push(...types.failures);
    // Every example with its own SDK / framework dependencies at latest.
    const all = new Set(Object.values(targets).flatMap((t) => t.packages));
    for (const dir of exampleDirs(cwd)) {
      const r = runExample(cwd, dir, Object.fromEntries(Object.keys(depsOf(dir)).filter((d) => all.has(d)).map((d) => [d, 'latest'])));
      if (!r.ok) failures.push(r.failure);
    }
    return { ok: !failures.length, failures, resolved };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(`${cwd}-examples`, { recursive: true, force: true });
  }
}

function writeResult(result) {
  const out = flag('--out');
  const line = { ...result, node: process.versions.node.split('.')[0], date: new Date().toISOString().slice(0, 10) };
  if (out) writeFileSync(out, JSON.stringify(line, null, 2));
  console.log(`\n${line.ok ? '✔' : '✘'} ${line.target}@${typeof line.resolved === 'string' ? line.resolved : line.spec} (${line.spec}, Node ${line.node})`);
  for (const f of line.failures) console.log(`    ✘ ${f}`);
  process.exit(line.ok ? 0 : 1);
}

/** compat/results.json: { [target]: { oldest: {version, ok, node, date}, latest: {...} } } */
function report(dirs) {
  const results = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : {};
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!targets[r.target] || !['oldest', 'latest'].includes(r.spec)) continue;
      const slot = ((results[r.target] ??= {})[r.spec] ??= {});
      const prev = slot.version === r.resolved ? slot.node ?? [] : [];
      Object.assign(slot, { version: r.resolved, ok: (slot.version === r.resolved ? slot.ok !== false : true) && r.ok, node: [...new Set([...prev, r.node])].sort(), date: r.date });
    }
  }
  const ordered = Object.fromEntries(Object.keys(targets).filter((t) => results[t]).map((t) => [t, results[t]]));
  writeFileSync(RESULTS_FILE, JSON.stringify(ordered, null, 2) + '\n');
  console.log(`updated ${RESULTS_FILE.replace(root, '')}`);
}

const README = join(root, 'README.md');
const START = '<!-- compat:start (generated by `node scripts/compat.mjs readme`; do not edit by hand) -->';
const END = '<!-- compat:end -->';

function table() {
  const results = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : {};
  const cell = (r) => (!r ? 'not yet run' : `${r.ok ? '✅' : '❌'} ${r.version} <sub>(Node ${r.node.join(', ')} · ${r.date})</sub>`);
  const rows = Object.entries(targets).map(([name, t]) => {
    const r = results[name] ?? {};
    const label = t.packages.map((p) => `\`${p}\``).join(' + ');
    return `| ${label} | \`>=${t.oldest}\` | ${cell(r.oldest)} | ${cell(r.latest)} |`;
  });
  return [START, '', '| Package | Supported | Oldest, tested | Latest, tested |', '|---|---|---|---|', ...rows, '', END].join('\n');
}

function readme(check) {
  const text = readFileSync(README, 'utf8');
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a === -1 || b === -1) throw new Error(`README.md has no compatibility markers (${START} … ${END})`);
  const next = text.slice(0, a) + table() + text.slice(b + END.length);
  if (check) {
    if (next !== text) {
      console.error('✘ README Compatibility table is out of date with compat/results.json. Run: node scripts/compat.mjs readme');
      process.exit(1);
    }
    console.log('✔ README Compatibility table matches compat/results.json');
  } else writeFileSync(README, next);
}

export function plan(kind, file = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'))) {
  const mid = file.node[Math.floor((file.node.length - 1) / 2)];
  const names = Object.keys(file.targets);
  if (kind === 'smoke') return names.filter((n) => file.targets[n].kind === 'sdk').map((target) => ({ target, spec: 'oldest', node: mid }));
  if (kind !== 'full') throw new Error(`plan: expected smoke or full, got ${kind}`);
  return [
    ...names.flatMap((target) => ['oldest', 'latest'].map((spec) => ({ target, spec, node: mid }))),
    ...file.node.map((node) => ({ target: 'all', spec: 'all-latest', node })),
  ];
}

/** Even-numbered Node lines in support on `today`, from the official schedule. */
export function supportedNodeLines(schedule, today) {
  return Object.entries(schedule)
    .map(([k, v]) => ({ major: Number(k.replace(/^v/, '')), ...v }))
    .filter((l) => Number.isInteger(l.major) && l.major % 2 === 0 && l.start <= today && today <= l.end)
    .map((l) => l.major)
    .sort((a, b) => a - b);
}

async function nodeCheck() {
  const res = await fetch('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json');
  const expected = supportedNodeLines(await res.json(), new Date().toISOString().slice(0, 10));
  const actual = JSON.parse(readFileSync(TARGETS_FILE, 'utf8')).node;
  const add = expected.filter((n) => !actual.includes(n));
  const drop = actual.filter((n) => !expected.includes(n));
  if (!add.length && !drop.length) return console.log(`✔ Node lines up to date: ${actual.join(', ')}`);
  console.log(`✘ Node lines in compat/targets.json (${actual.join(', ')}) don't match the release schedule (${expected.join(', ')}).`);
  if (add.length) console.log(`  Add: ${add.join(', ')} (released). Update compat/targets.json, the CI matrix and the README.`);
  if (drop.length) console.log(`  Drop: ${drop.join(', ')} (end of life). Also raise "engines" in package.json: a minor release.`);
  process.exit(1);
}

// CLI (guarded so tests can import the helpers above).
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === 'run') {
    const [target, spec = 'latest'] = rest;
    writeResult({ target, spec, ...runOne(target, spec) });
  } else if (command === 'run-all-latest') {
    writeResult({ target: 'all', spec: 'all-latest', ...runAllLatest() });
  } else if (command === 'report') report(rest);
  else if (command === 'readme') readme(rest.includes('--check'));
  else if (command === 'node-check') await nodeCheck();
  else if (command === 'lint') {
    readme(true);
    const nodes = JSON.parse(readFileSync(TARGETS_FILE, 'utf8')).node;
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').match(/node:\s*\[([^\]]*)\]/)?.[1];
    if (ci?.split(',').map((n) => Number(n.trim())).join() !== nodes.join()) {
      console.error(`✘ .github/workflows/ci.yml tests Node [${ci}], compat/targets.json says [${nodes.join(', ')}]`);
      process.exit(1);
    }
    console.log(`✔ CI Node matrix matches compat/targets.json (${nodes.join(', ')})`);
  }
  else if (command === 'plan') console.log(JSON.stringify({ include: plan(rest[0]) }));
  else {
    console.error('usage: compat.mjs run <target> <oldest|latest|x.y.z> [--out f] | run-all-latest [--out f] | report <dir>… | node-check | readme [--check]');
    process.exit(2);
  }
}
