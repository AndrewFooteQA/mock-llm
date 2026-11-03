import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Relative links in the Markdown docs must point at files that exist. npm rewrites them to
// github.com/…/blob/HEAD/<path> on the package page, so a stale one is a 404 for every npm visitor
// (regression: README linked examples/claude-code.mjs long after it became examples/claude-code-cli).
// Links with a #fragment into a Markdown file must also name a heading in it, since sections move between
// the README and docs/ (a stale anchor lands at the top of the page, silently).
const root = fileURLToPath(new URL('../..', import.meta.url));
const docs = [
  'README.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  'CHANGELOG.md',
  ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  'examples/README.md',
  ...readdirSync(join(root, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, 'examples', d.name, 'README.md')))
    .map((d) => `examples/${d.name}/README.md`),
];

const stripCode = (md: string) => md.replace(/```[\s\S]*?```/g, '');

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces → hyphens, repeats get -1, -2, … */
function anchorsOf(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, heading] of stripCode(md).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = heading!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n ? `${slug}-${n}` : slug);
  }
  return out;
}

describe('relative links in the docs resolve', () => {
  it.each(docs)('%s', (doc) => {
    const file = join(root, doc);
    const targets = [...stripCode(readFileSync(file, 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1]!)
      .filter((t) => !/^(https?:|mailto:)/.test(t));
    const broken = targets.filter((t) => {
      const [path, anchor] = t.split('#') as [string, string | undefined];
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      if (!existsSync(target)) return true;
      if (anchor === undefined || !target.endsWith('.md')) return false;
      return !anchorsOf(readFileSync(target, 'utf8')).has(decodeURIComponent(anchor));
    });
    expect(broken.map((t) => `${t} (from ${relative(root, file)})`)).toEqual([]);
  });

  it('computes GitHub anchors for the headings the docs link to', () => {
    expect([...anchorsOf('## Scenario files (YAML / JSON)\n### Reproducing a run (`MOCK_LLM_SEED`)\n## Agent / tool loops\n## Faults\n## Faults')])
      .toEqual(['scenario-files-yaml--json', 'reproducing-a-run-mock_llm_seed', 'agent--tool-loops', 'faults', 'faults-1']);
  });
});
