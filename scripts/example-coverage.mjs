// Example coverage (ROADMAP R19): which library features the example projects actually use.
//
//   npm run coverage:examples              → table grouped by area, then the gate result
//   npm run coverage:examples -- --json    → machine-readable report
//   npm run coverage:examples -- --by-example → per-example feature lists (to check the three example indexes)
//
// The feature inventory is read from the library source, not from a hand-kept list:
// exported values, faults / edge / built-in scenario names, matchers, RuleBuilder methods, MockLLMOptions and
// Matcher keys, scenario-file step actions and modifiers, and event names. examples/coverage.json adds what the
// inventory can't see (provider SDK calls and endpoints), exemptions with reasons, and the `required` list.
//
// Exit 1 when a required feature is uncovered, or when an inventory item is neither covered nor exempt, so a new
// export, fault, matcher or option fails the check until an example uses it (or it's exempted with a reason).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------- inventory extraction (pure, unit-tested)

/**
 * `text` with the contents of string literals, template literals and comments blanked out (same length, newlines
 * kept), so brackets inside them don't count when matching braces.
 */
export function maskStrings(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    let end = -1;
    if (two === '//') end = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
    else if (two === '/*') end = text.indexOf('*/', i + 2) + 2;
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += c + text.slice(i + 1, j).replace(/[^\n]/g, ' ') + (text[j] ?? '');
      i = j;
      continue;
    }
    if (end > i) {
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end - 1;
    } else out += c;
  }
  return out;
}

/** The `{ … }` body that follows `start` (a regex) in `text`, matching braces outside strings and comments. */
export function blockAfter(text, start) {
  const m = start.exec(text);
  if (!m) throw new Error(`example-coverage: ${start} not found in source`);
  const masked = maskStrings(text);
  let i = masked.indexOf('{', m.index + m[0].length - 1);
  const from = i + 1;
  for (let depth = 0; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return text.slice(from, i);
  }
  throw new Error(`example-coverage: unbalanced braces after ${start}`);
}

/** Top-level keys of an object literal / interface / class body (one level deep, comments stripped). */
export function topLevelKeys(body) {
  const lines = body.split('\n');
  const maskedLines = maskStrings(body).split('\n');
  const keys = [];
  let depth = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (depth === 0 && maskedLines[n].trim()) {
      const m = line.match(/^\s*(?:readonly\s+|static\s+|async\s+|get\s+)*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?:\?\s*)?[:(<,]/) ?? line.match(/^\s*([A-Za-z_$][\w$]*),\s*$/);
      if (m) keys.push(m[1] ?? m[2] ?? m[3]);
    }
    for (const c of maskedLines[n]) depth += c === '{' || c === '(' || c === '[' ? 1 : c === '}' || c === ')' || c === ']' ? -1 : 0;
  }
  return [...new Set(keys)];
}

/** Value names exported by an `index.ts` (`export { a, b as c, type T }`, `export function/const/class x`). */
export function exportedValues(text) {
  const names = [];
  for (const m of text.matchAll(/export\s+(?!type\b)\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p || p.startsWith('type ')) continue;
      names.push(p.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  return [...new Set(names)];
}

/** A string-array constant: `const ACTIONS = ['a', 'b'] as const`. */
export function stringArray(text, name) {
  const m = text.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`example-coverage: const ${name} not found`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The inventory: feature id → { area, label, patterns }. Ids are `area:name`. Patterns are the default ways an
 * example uses the feature (code, YAML, prompt tokens, headers).
 */
export function buildInventory(read) {
  const inv = new Map();
  const add = (area, name, patterns, label = name) => inv.set(`${area}:${name}`, { area, label, patterns: patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p))) });

  // Exports count when an example imports them from the package (comments and look-alike names don't).
  const imported = (name, from = 'mock-llm') => `import\\s+(?:type\\s+)?\\{[^}]*\\b${esc(name)}\\b[^}]*\\}\\s*from\\s*['"]${esc(from)}['"]`;
  const matcherNames = new Set(topLevelKeys(blockAfter(read('src/assert/index.ts'), /export const assertions\s*=\s*\{/)));
  for (const name of exportedValues(read('src/index.ts'))) {
    // A matcher is also used without importing it: `expect(mock).toHaveReceivedRequest(...)`.
    add('export', name, [imported(name), ...(matcherNames.has(name) ? [`\\.${name}\\(`] : [])]);
  }
  // The test-framework entry points, and what each exports.
  for (const entry of ['vitest', 'jest', 'playwright']) {
    const from = `mock-llm/${entry}`;
    add('entry', from, [`from\\s*['"]${esc(from)}['"]`]);
    for (const name of exportedValues(read(`src/testing/${entry}.ts`))) add('entry', `${entry}.${name}`, [imported(name, from)], `${from} › ${name}`);
  }
  for (const name of topLevelKeys(blockAfter(read('src/core/faults.ts'), /export const faults\s*=\s*\{/))) {
    add('fault', name, [`faults\\.${name}\\(`, `fail:\\s*\\{\\s*${name}\\b`, `\\[\\[mock:${camelToKebab(name)}\\]\\]`]);
  }
  for (const name of topLevelKeys(blockAfter(read('src/core/edge.ts'), /export const edge\s*=\s*\{/))) {
    add('edge', name, [`edge\\.${name}\\(`, `edge:\\s*['"]?${name}\\b`]);
  }
  for (const name of topLevelKeys(blockAfter(read('src/core/scenarios.ts'), /export const builtinScenarios[^=]*=\s*\{/))) {
    add('scenario', name, [
      `\\[\\[mock:${esc(name)}\\]\\]`,
      `x-mock-scenario['"]?\\s*[:,]\\s*['"]${esc(name)}['"]`,
      `x-mock-scenario:\\s*${esc(name)}\\b`,
      // A sweep over every built-in scenario covers each of them.
      'Object\\.(keys|entries)\\(builtinScenarios\\)',
    ]);
  }
  for (const name of topLevelKeys(blockAfter(read('src/assert/index.ts'), /export const assertions\s*=\s*\{/))) add('matcher', name, [`\\b${name}\\(`]);
  for (const name of topLevelKeys(blockAfter(read('src/core/rules.ts'), /export class RuleBuilder\s*\{/))) {
    if (name === 'constructor') continue;
    add('rule', name, name === 'then' ? ['\\.then\\.(reply|fail)'] : [`\\.${name}\\(`, ...(name === 'once' ? ['once:\\s*true'] : [])]);
  }
  for (const name of topLevelKeys(blockAfter(read('src/mock.ts'), /export interface MockLLMOptions\s*\{/))) {
    add('option', name, [`\\b${name}\\s*:`, `\\b${name}\\s*[,}]`]);
  }
  for (const name of topLevelKeys(blockAfter(read('src/core/rules.ts'), /export interface Matcher\s*\{/))) {
    add('match', name, [`when\\([^)]*\\b${name}\\s*:`, `when:\\s*\\{[^}]*\\b${name}\\s*:`]);
  }
  const sf = read('src/core/scenario-file.ts');
  for (const name of stringArray(sf, 'ACTIONS')) add('step', name, [`(^|[\\s{,-])${name}:`]);
  for (const name of stringArray(sf, 'MODIFIERS')) add('modifier', name, [`\\b${name}\\s*:`]);
  for (const name of topLevelKeys(blockAfter(read('src/mock.ts'), /export interface MockLLMEvents\s*\{/))) add('event', name, [`\\.on\\(\\s*['"]${name}['"]`]);
  return inv;
}

// ---------------------------------------------------------------- scanning (pure, unit-tested)

const SKIP_DIRS = new Set(['node_modules', 'test-results', 'playwright-report', 'dist', '.git']);
// tsconfig's `"strict": true` would otherwise count as using the `strict` option.
const SKIP_FILES = /(^|\/)(package-lock\.json|README\.md|tsconfig[\w.-]*\.json)$/;
const SCAN = /\.(m?[jt]s|json|ya?ml|html)$/;

export function filesOf(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...filesOf(p));
    } else if (SCAN.test(entry) && !SKIP_FILES.test(p)) out.push(p);
  }
  return out;
}

/**
 * Which features each example uses. `sources`: { example: { file: text } }. Features: id → { patterns }.
 * Returns id → [{ example, files }].
 */
export function scan(features, sources) {
  const hits = new Map();
  for (const [id, f] of features) {
    const where = [];
    for (const [example, files] of Object.entries(sources)) {
      const matched = Object.entries(files).filter(([, text]) => f.patterns.some((re) => re.test(text))).map(([file]) => file);
      if (matched.length) where.push({ example, files: matched });
    }
    hits.set(id, where);
  }
  return hits;
}

/** Combine inventory, the surface map, exemptions and the required list into a report. */
export function evaluate(inventory, config, sources) {
  const features = new Map(inventory);
  for (const [id, f] of Object.entries(config.surface ?? {})) {
    features.set(id, { area: id.split(':')[0], label: f.label ?? id.split(':').slice(1).join(':'), patterns: [].concat(f.patterns).map((p) => new RegExp(p)) });
  }
  const hits = scan(features, sources);
  const exempt = config.exempt ?? {};
  const rows = [...features].map(([id, f]) => {
    const where = hits.get(id) ?? [];
    const status = where.length ? 'covered' : exempt[id] ? 'exempt' : 'uncovered';
    return { id, area: f.area, label: f.label, status, examples: where.map((w) => w.example), files: where.flatMap((w) => w.files), reason: exempt[id] };
  });
  const problems = [];
  for (const id of config.required ?? []) {
    const row = rows.find((r) => r.id === id);
    if (!row) problems.push(`required feature "${id}" is not in the inventory or the surface map`);
    else if (row.status !== 'covered') problems.push(`required feature "${id}" is not used by any example`);
  }
  for (const r of rows) if (r.status === 'uncovered') problems.push(`"${r.id}" is neither used by an example nor exempt (add it to an example, or to "exempt" in examples/coverage.json with a reason)`);
  for (const id of Object.keys(exempt)) if (!features.has(id)) problems.push(`exemption "${id}" doesn't match any feature (remove it)`);
  for (const r of rows) if (r.status === 'covered' && exempt[r.id]) problems.push(`"${r.id}" is exempt but an example now uses it (remove the exemption)`);
  return { rows, problems };
}

// ---------------------------------------------------------------- CLI

function main() {
  const root = new URL('..', import.meta.url).pathname;
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const config = JSON.parse(read('examples/coverage.json'));
  const sources = {};
  for (const name of readdirSync(join(root, 'examples'))) {
    const dir = join(root, 'examples', name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) continue;
    sources[name] = Object.fromEntries(filesOf(dir).filter((f) => !f.endsWith('package.json')).map((f) => [relative(dir, f), readFileSync(f, 'utf8')]));
  }
  const { rows, problems } = evaluate(buildInventory(read), config, sources);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, problems }, null, 2));
  } else if (process.argv.includes('--by-example')) {
    for (const example of Object.keys(sources).sort()) {
      const used = rows.filter((r) => r.examples.includes(example)).map((r) => r.id);
      console.log(`\n${example} (${used.length})\n  ${used.join(', ')}`);
    }
  } else {
    const areas = [...new Set(rows.map((r) => r.area))];
    const mark = { covered: '✔', exempt: '·', uncovered: '✘' };
    for (const area of areas) {
      const inArea = rows.filter((r) => r.area === area);
      const covered = inArea.filter((r) => r.status === 'covered').length;
      console.log(`\n${area} (${covered}/${inArea.length} covered)`);
      for (const r of inArea) {
        const detail = r.status === 'covered' ? r.examples.join(', ') : r.status === 'exempt' ? `exempt: ${r.reason}` : 'UNCOVERED';
        console.log(`  ${mark[r.status]} ${r.label.padEnd(28)} ${detail}`);
      }
    }
    const count = (s) => rows.filter((r) => r.status === s).length;
    console.log(`\n${rows.length} features: ${count('covered')} covered, ${count('exempt')} exempt, ${count('uncovered')} uncovered`);
  }
  if (problems.length) {
    console.error(`\n✘ example coverage:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  if (!process.argv.includes('--json')) console.log('✔ example coverage: every required feature is used, and nothing is uncovered');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
