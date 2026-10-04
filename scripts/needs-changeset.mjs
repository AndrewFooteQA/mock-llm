// Does this branch change what ships, so it needs a changeset? (CI, on pull requests.)
//   node scripts/needs-changeset.mjs [base=origin/main]  → prints the reason and exits 0 if yes, 1 if no
// "Ships" = src/ or a package.json field users get (dependencies, peers, exports, engines, files…), per CLAUDE.md.
// Dev-only changes don't: tests, docs, examples, workflows, devDependencies and lockfiles (e.g. Renovate PRs).
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const SHIPPED_FIELDS = ['name', 'type', 'main', 'types', 'exports', 'files', 'bin', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies', 'engines'];

export function shippedChanges(changedFiles, basePkg, headPkg) {
  const reasons = changedFiles.filter((f) => f.startsWith('src/')).map((f) => `${f} changed`);
  if (basePkg && headPkg) {
    for (const k of SHIPPED_FIELDS) if (JSON.stringify(basePkg[k]) !== JSON.stringify(headPkg[k])) reasons.push(`package.json "${k}" changed`);
  }
  return reasons;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mergeBase = git('merge-base', base, 'HEAD').trim();
  const files = git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);
  const read = (ref) => {
    try {
      return JSON.parse(git('show', `${ref}:package.json`));
    } catch {
      return undefined;
    }
  };
  const reasons = shippedChanges(files, read(mergeBase), read('HEAD'));
  if (reasons.length) {
    console.log(`Changeset needed: ${reasons.join('; ')}`);
    process.exit(0);
  }
  console.log('No changeset needed: nothing that ships changed (src/ and package.json release fields are untouched).');
  process.exit(1);
}
