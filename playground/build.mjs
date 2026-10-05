// Static build of the playground for GitHub Pages (ROADMAP R20): the same frontend, replaying recorded runs.
//   npm run playground:build   → builds the library, records every run (playground:check --record), writes site/
//   node playground/build.mjs --skip-record   → reuse playground/.recordings (e.g. right after npm run check)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const site = join(root, 'site');
const recordings = join(here, '.recordings');
const run = (cmd, args) => {
  if (spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }).status !== 0) process.exit(1);
};

if (!process.argv.includes('--skip-record') || !existsSync(recordings)) {
  run('npm', ['run', 'build']);
  run(process.execPath, ['playground/check.mjs', '--record', recordings]); // fails on any failure or missing recording
}
const { buildMeta, DOCS } = await import('./meta.mjs');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

rmSync(site, { recursive: true, force: true });
cpSync(join(here, 'public'), site, { recursive: true });
// The marker the frontend's transport reads (static mode), plus the version for "Run it live" and the badge.
const indexPath = join(site, 'index.html');
const html = readFileSync(indexPath, 'utf8');
if (!html.includes('<html lang="en">')) throw new Error('playground build: <html lang="en"> not found in index.html');
writeFileSync(indexPath, html.replace('<html lang="en">', `<html lang="en" data-mode="static" data-version="${version}">`));
writeFileSync(join(site, 'meta.json'), JSON.stringify(buildMeta()));
mkdirSync(join(site, 'docs'));
for (const doc of DOCS) cpSync(join(root, `${doc}.md`), join(site, 'docs', `${doc}.md`));
cpSync(recordings, join(site, 'recordings'), { recursive: true });
writeFileSync(join(site, '.nojekyll'), ''); // serve files as-is (no Jekyll processing)

const count = readdirSync(join(site, 'recordings')).length;
console.log(`✔ site/ built for mock-llm v${version}: ${count} recordings, meta.json, ${DOCS.length} docs`);
