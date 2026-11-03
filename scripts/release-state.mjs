// Did this release run publish the current version? (release.yml)
//   node scripts/release-state.mjs before   → outputs version, existed (was it already on npm before publishing?)
//   node scripts/release-state.mjs after <existed> → outputs published=true when it wasn't on npm before and is now
//
// The changesets step can publish to npm and then fail on a later GitHub API call (tag push, GitHub Release), as on
// 2026-10-06 (0.2.2). Its `published` output is then empty, so the post-publish verification and the docs deploy
// would be skipped. Comparing npm before and after tells us what actually happened.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

/** Is `name@version` on the registry? Retries while a version that was just published propagates. */
export async function onNpm(name, version, { attempts = 1, waitMs = 0, view = npmView, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 1; i <= attempts; i++) {
    if (view(`${name}@${version}`) === version) return true;
    if (i < attempts) await sleep(waitMs);
  }
  return false;
}

/** The release decision: published now = absent before the publish step and present after it. */
export const publishedNow = (existedBefore, existsAfter) => !existedBefore && existsAfter;

function npmView(spec) {
  try {
    return execFileSync('npm', ['view', spec, 'version', '--prefer-online'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // E404: not published
  }
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(lines.join(' '));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const [mode, existed] = process.argv.slice(2);
  if (mode === 'before') {
    output({ version, existed: await onNpm(name, version) });
  } else if (mode === 'after') {
    const before = existed === 'true';
    // Only wait for propagation when there's something to wait for (up to ~5 minutes).
    const after = before ? true : await onNpm(name, version, { attempts: 10, waitMs: 30_000 });
    output({ version, published: publishedNow(before, after) });
  } else {
    console.error('usage: release-state.mjs before | after <existed>');
    process.exit(2);
  }
}
