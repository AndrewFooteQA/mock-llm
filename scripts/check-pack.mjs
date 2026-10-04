// Verify what `npm publish` would ship: only built files + docs, and every `exports` target present.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const out = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const report = Array.isArray(out) ? out[0] : Object.values(out)[0]; // npm ≤11: array; npm 12: keyed by name
const files = report.files.map((f) => f.path).sort();

const allowed = [/^dist\/.+\.(js|d\.ts)$/, /^README\.md$/, /^LICENSE$/, /^CHANGELOG\.md$/, /^package\.json$/];
const problems = [];
for (const f of files) if (!allowed.some((re) => re.test(f))) problems.push(`unexpected file in package: ${f}`);

const targets = Object.values(pkg.exports).flatMap((e) => [e.types, e.import]).map((p) => p.replace(/^\.\//, ''));
for (const t of [...targets, 'README.md', 'LICENSE', 'CHANGELOG.md']) if (!files.includes(t)) problems.push(`missing from package: ${t}`);
if (Object.keys(pkg.dependencies ?? {}).length) problems.push(`runtime dependencies are not allowed: ${Object.keys(pkg.dependencies).join(', ')}`);

console.log(`${pkg.name}@${pkg.version}: ${files.length} files, ${(report.size / 1024).toFixed(1)} kB packed, ${(report.unpackedSize / 1024).toFixed(1)} kB unpacked`);
for (const p of problems) console.log(`  ✘ ${p}`);
if (problems.length) process.exit(1);
console.log('  ✔ package contents OK');
