import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Relative links in the Markdown docs must point at files that exist. npm rewrites them to
// github.com/…/blob/HEAD/<path> on the package page, so a stale one is a 404 for every npm visitor
// (regression: README linked examples/claude-code.mjs long after it became examples/claude-code-cli).
const root = fileURLToPath(new URL('../..', import.meta.url));
const docs = [
  'README.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  'CHANGELOG.md',
  'examples/README.md',
  ...readdirSync(join(root, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, 'examples', d.name, 'README.md')))
    .map((d) => `examples/${d.name}/README.md`),
];

describe('relative links in the docs resolve', () => {
  it.each(docs)('%s', (doc) => {
    const text = readFileSync(join(root, doc), 'utf8').replace(/```[\s\S]*?```/g, '');
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((t) => !/^(https?:|mailto:|#)/.test(t));
    const missing = targets.filter((t) => !existsSync(resolve(dirname(join(root, doc)), decodeURIComponent(t.split('#')[0]!))));
    expect(missing).toEqual([]);
  });
});
