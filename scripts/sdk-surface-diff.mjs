// SDK surface diff (ROADMAP R17): what changed in the parts of a provider SDK that mock-llm impersonates.
//
//   node scripts/sdk-surface-diff.mjs <package> <fromVersion> <toVersion>
//   node scripts/sdk-surface-diff.mjs --locks <base package-lock.json> <head package-lock.json>
//       (CI on dependency PRs: diff every tracked SDK whose locked version changed)
//
// Prints Markdown: types and members added/removed in the relevant .d.ts files (stream events, content blocks,
// request parameters, endpoints, error classes). It is a reading aid for the SDK update playbook in CLAUDE.md, not a
// verdict: the compatibility matrix and the contract tests decide whether the mock still works.
//
// The .d.ts files are scanned with a small declaration parser rather than the TypeScript compiler API (TypeScript 7
// only offers an unstable JS API). It understands interfaces, classes, namespaces, enums and type aliases (union
// members and string literals), which is what SDK surface changes consist of.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/** Which files of each SDK describe the surface the mock implements. Paths are relative to the package root. */
export const SURFACES = {
  openai: [
    /^resources\/(chat\/completions|responses|embeddings|models)[/.]/,
    /^resources\/shared\.d\.ts$/,
    /^(core\/)?error\.d\.ts$/,
    /^(core\/)?streaming\.d\.ts$/,
    /^lib\/(ChatCompletionStream|responses\/ResponseStream)\.d\.ts$/,
  ],
  '@anthropic-ai/sdk': [
    /^resources\/messages[/.]/,
    /^resources\/models\.d\.ts$/,
    /^(core\/)?error\.d\.ts$/,
    /^(core\/)?streaming\.d\.ts$/,
    /^lib\/MessageStream\.d\.ts$/,
  ],
  '@google/genai': [/^dist\/node\/node\.d\.ts$/, /^dist\/genai\.d\.ts$/],
  '@aws-sdk/client-bedrock-runtime': [
    /^dist-types\/models\/(models_\d+|errors|enums)\.d\.ts$/,
    /^dist-types\/commands\/(Converse|ConverseStream|InvokeModel|InvokeModelWithResponseStream|CountTokens)Command\.d\.ts$/,
  ],
};

/** Names worth a closer look when they change: they map to wire shapes the adapters render or parse. */
const HOT = /Stream|Event|Delta|Block|Content|Part|Error|Exception|Reason|Usage|Tool|Function|Thinking|Citation|Candidate|Choice|Message|Embedding/;

// Not member names. (`type` is deliberately absent: `type: 'text'` is the most common member in SDK declarations.)
const KEYWORDS = new Set(['export', 'import', 'declare', 'interface', 'class', 'namespace', 'module', 'enum', 'function', 'const', 'let', 'var', 'return', 'extends', 'implements']);

/** Parse declaration text into { qualifiedName: { kind, members: Set } }. */
export function parseDeclarations(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const symbols = new Map();
  const scopes = []; // { name, depth, kind }: open declaration bodies
  let depth = 0;
  let alias = null; // a type alias being read: { sym, startDepth, body }
  const sym = (name, kind) => {
    if (!symbols.has(name)) symbols.set(name, { kind, members: new Set() });
    return symbols.get(name);
  };
  const qualify = (name) => [...scopes.filter((s) => s.kind === 'namespace' || s.kind === 'module').map((s) => s.name), name].join('.');

  for (const line of src.split('\n')) {
    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    const top = scopes.at(-1);

    if (alias) {
      alias.body += ` ${line}`;
    } else {
      const decl = line.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|type|class|enum|namespace|module)\s+([\w$]+)/);
      if (decl) {
        const [, kind, name] = decl;
        const s = sym(qualify(name), kind);
        if (kind === 'type' && !/=\s*{\s*$/.test(line)) {
          alias = { sym: s, startDepth: depth, body: line.slice(line.indexOf('=') + 1) };
        } else if (opens > closes) {
          scopes.push({ name, depth, kind, sym: s });
        }
      } else if (top && depth === top.depth + 1 && top.kind !== 'namespace' && top.kind !== 'module') {
        const m = line.match(/^\s*(?:(?:readonly|static|private|protected|public|abstract|get|set|async)\s+)*(['"]?)([\w$-]+)\1\??\s*[:(<=,]/);
        if (m && !KEYWORDS.has(m[2])) {
          top.sym.members.add(m[2] + (/^\s*[^:]*\(/.test(line.slice(m.index + m[0].length - 1)) && m[0].trim().endsWith('(') ? '()' : ''));
          // String literals in the member's type (`detail?: 'auto' | 'low'`): a new allowed value is a wire change too.
          // Only the declaration line is read, so a union spread over several lines is reported by member name only.
          const type = line.slice(m.index + m[0].length);
          for (const lit of type.match(/'[^']*'|"[^"]*"/g) ?? []) top.sym.members.add(`${m[2]}:${lit.replace(/"/g, "'")}`);
        }
      }
    }

    depth += opens - closes;
    if (alias && depth <= alias.startDepth && /;\s*$/.test(line)) {
      // Union members: string literals and referenced type names at the top level of the alias.
      const body = alias.body.replace(/{[^{}]*}/g, '{…}');
      for (const lit of body.match(/'[^']*'|"[^"]*"/g) ?? []) alias.sym.members.add(lit.replace(/"/g, "'"));
      for (const ref of body.match(/(?:^|[|&=<,(])\s*([A-Z][\w$.]*)/g) ?? []) alias.sym.members.add(ref.replace(/^[^A-Za-z]*/, ''));
      alias = null;
    }
    while (scopes.length && depth <= scopes.at(-1).depth) scopes.pop();
  }
  return symbols;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Download `pkg@version` and parse its relevant declaration files. */
function surface(pkg, version, work) {
  const dir = join(work, version);
  execFileSync('mkdir', ['-p', dir]);
  const tgz = execFileSync('npm', ['pack', `${pkg}@${version}`, '--silent', '--pack-destination', dir], { encoding: 'utf8' }).trim().split('\n').at(-1);
  execFileSync('tar', ['xzf', join(dir, tgz), '-C', dir]);
  const base = join(dir, 'package');
  const files = walk(base)
    .map((f) => relative(base, f))
    .filter((f) => f.endsWith('.d.ts') && !f.includes('ts3.4') && SURFACES[pkg].some((re) => re.test(f)));
  const all = new Map();
  for (const f of files) for (const [name, s] of parseDeclarations(readFileSync(join(base, f), 'utf8'))) {
    const prev = all.get(name);
    if (prev) for (const m of s.members) prev.members.add(m);
    else all.set(name, s);
  }
  return { files, symbols: all };
}

export function diffSurfaces(a, b) {
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed = [...b.keys()]
    .filter((k) => a.has(k))
    .map((k) => {
      const [x, y] = [a.get(k).members, b.get(k).members];
      return { name: k, added: [...y].filter((m) => !x.has(m)).sort(), removed: [...x].filter((m) => !y.has(m)).sort() };
    })
    .filter((c) => c.added.length || c.removed.length)
    .sort((p, q) => p.name.localeCompare(q.name));
  return { added, removed, changed };
}

const LIMIT = 60;
const list = (items, fmt) => [...items.slice(0, LIMIT).map(fmt), ...(items.length > LIMIT ? [`- …and ${items.length - LIMIT} more`] : [])];
const hot = (name) => (HOT.test(name) ? ' 🔎' : '');

export function markdown(pkg, from, to, a, b, d) {
  const out = [`### \`${pkg}\` ${from} → ${to}`, ''];
  out.push(`Scanned ${b.files.length} declaration file(s) matching the mock's surface (${SURFACES[pkg].length} path patterns).`, '');
  if (!a.files.length || !b.files.length) out.push('⚠️ No declaration files matched in one of the versions: the SDK layout probably changed. Update `SURFACES` in `scripts/sdk-surface-diff.mjs`.', '');
  if (!d.added.length && !d.removed.length && !d.changed.length) return [...out, 'No surface changes in the scanned files.'].join('\n');
  out.push('🔎 = name suggests a wire shape the adapters render or parse (stream events, content blocks, errors, usage, tools).', '');
  if (d.removed.length) out.push(`**Removed types (${d.removed.length})**`, ...list(d.removed, (n) => `- \`${n}\`${hot(n)}`), '');
  if (d.added.length) out.push(`**Added types (${d.added.length})**`, ...list(d.added, (n) => `- \`${n}\`${hot(n)}`), '');
  if (d.changed.length) {
    out.push(`**Changed types (${d.changed.length})**`);
    out.push(...list(d.changed, (c) => `- \`${c.name}\`${hot(c.name)}: ${[...c.added.map((m) => `+\`${m}\``), ...c.removed.map((m) => `−\`${m}\``)].join(' ')}`), '');
  }
  return out.join('\n');
}

export function surfaceDiff(pkg, from, to) {
  if (!SURFACES[pkg]) throw new Error(`no surface definition for ${pkg}. Known: ${Object.keys(SURFACES).join(', ')}`);
  const work = mkdtempSync(join(tmpdir(), 'mock-llm-surface-'));
  try {
    const a = surface(pkg, from, work);
    const b = surface(pkg, to, work);
    return markdown(pkg, from, to, a, b, diffSurfaces(a.symbols, b.symbols));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function lockedVersions(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  return Object.fromEntries(Object.keys(SURFACES).map((p) => [p, lock.packages?.[`node_modules/${p}`]?.version]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--locks') {
    const [base, head] = [lockedVersions(args[1]), lockedVersions(args[2])];
    const changed = Object.keys(SURFACES).filter((p) => base[p] && head[p] && base[p] !== head[p]);
    const sections = changed.map((p) => surfaceDiff(p, base[p], head[p]));
    console.log(
      [
        '<!-- sdk-surface-diff -->',
        '## SDK surface diff',
        '',
        changed.length ? `Changed SDKs: ${changed.map((p) => `\`${p}\` ${base[p]} → ${head[p]}`).join(', ')}.` : 'No tracked provider SDK changed version in this PR.',
        'Classify this update with the playbook in `CLAUDE.md` › *SDK updates* and record the decision in this PR.',
        '',
        ...sections,
      ].join('\n'),
    );
  } else if (args.length === 3) {
    console.log(surfaceDiff(...args));
  } else {
    console.error('usage: sdk-surface-diff.mjs <package> <from> <to> | --locks <base-lock> <head-lock>');
    process.exit(2);
  }
}
