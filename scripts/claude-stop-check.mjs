// Claude Code Stop hook: enforces the definition of done in CLAUDE.md.
//
// - Nothing relevant changed since the last passing check → allow (instant).
// - Otherwise run `npm run check`; if it fails, block and feed the failure back.
// - If the check keeps failing with no further edits, stop blocking (no loops) and warn.
// - If src/ changed without test or docs changes, block once with a reminder.
//   Claude Code sets `stop_hook_active` on the retry, so a reminder never loops:
//   Claude either adds the tests/docs or explains why none are needed.
//
// State lives in .claude/.dod-state.json (gitignored) and is only updated after a
// passing check. Run by hand: echo '{}' | node scripts/claude-stop-check.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const STATE = join(root, '.claude', '.dod-state.json');
const WATCH = ['src', 'tests', 'playground', 'examples', 'scripts', 'README.md', 'CLAUDE.md', 'package.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.build.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
// Lockfiles are rewritten by `npm run test:examples` itself (the packed mock-llm changes every build).
const SKIP_FILES = new Set(['package-lock.json']);

const input = (() => {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
})();

function snapshot() {
  const files = {};
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) walk(join(p, name));
    } else if (!SKIP_FILES.has(p.split('/').pop())) {
      files[relative(root, p)] = `${st.size}:${Math.floor(st.mtimeMs)}`;
    }
  };
  for (const w of WATCH) walk(join(root, w));
  return files;
}

const respond = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

const now = snapshot();
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
const changed = saved
  ? [...new Set([...Object.keys(now), ...Object.keys(saved.files)])].filter((f) => now[f] !== saved.files[f])
  : null; // first run: no baseline, so just verify everything

if (changed && changed.length === 0) process.exit(0);

const touched = (prefix) => changed?.some((f) => f === prefix || f.startsWith(`${prefix}/`)) ?? false;
const codeChanged = !changed || changed.some((f) => f !== 'CLAUDE.md');
if (!codeChanged) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ files: now, checkedAt: new Date().toISOString() }));
  process.exit(0);
}

// Already blocked on a failing check for exactly this state? Don't loop: let Claude stop
// (CLAUDE.md requires it to report the failure) and warn the user.
const fingerprint = JSON.stringify(now);
if (input.stop_hook_active && saved?.failed === fingerprint) {
  respond({ systemMessage: '⚠ npm run check is still failing. Claude was asked to report why.' });
}

const check = spawnSync('npm', ['run', 'check'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 14 * 60 * 1000 });
const output = `${check.stdout ?? ''}${check.stderr ?? ''}`;
if (check.status !== 0) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ...(saved ?? { files: {} }), failed: fingerprint }));
  const tail = output
    .split('\n')
    .filter((l) => !/npm notice|install-scripts/.test(l))
    .slice(-60)
    .join('\n');
  respond({
    decision: 'block',
    reason: `Definition of done (CLAUDE.md): \`npm run check\` failed${check.error ? ` (${check.error.message})` : ''}. Fix it before finishing, or tell the user plainly what is failing and why. Last output:\n\n${tail}`,
  });
}

// The check passed: record this state as verified.
mkdirSync(join(root, '.claude'), { recursive: true });
writeFileSync(STATE, JSON.stringify({ files: now, checkedAt: new Date().toISOString() }));

const reminders = [];
if (changed && touched('src')) {
  if (!touched('tests')) {
    reminders.push('src/ changed but nothing under tests/ did. Add tests (a regression test for bug fixes; a contract test through the official SDK for wire-format changes).');
  }
  if (!touched('README.md') && !touched('playground/public')) {
    reminders.push('src/ changed but neither README.md nor the playground (lessons.js / Reference in app.js) did. Update the docs and tutorial for any user-facing change.');
  }
  if (!touched('examples')) {
    reminders.push('No example project changed. Confirm no example should demonstrate this (new providers or major features need one).');
  }
}

if (reminders.length && !input.stop_hook_active) {
  respond({
    decision: 'block',
    reason: `\`npm run check\` passed, but CLAUDE.md's definition of done may be incomplete:\n- ${reminders.join('\n- ')}\nAddress these, or if the change genuinely needs none (e.g. an internal refactor), say so explicitly in your reply.`,
  });
}

respond({ systemMessage: '✔ Definition-of-done check passed (npm run check).' });
