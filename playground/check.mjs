// Runs every tutorial lesson × variant × provider through the playground server and
// verifies each run completes, and errors exactly when the lesson says it should
// (`expectError`). Run after changing the library, the lessons or the server.
//   npm run playground:check
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LESSONS, PROVIDERS } from './public/lessons.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const server = spawn(process.execPath, ['server.mjs'], { cwd: here, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const [line] = await once(server.stdout, 'data');
const port = String(line).match(/localhost:(\d+)/)?.[1];
if (!port) throw new Error(`playground server did not start: ${line}`);

const failures = [];
let runs = 0;
try {
  for (const lesson of LESSONS.filter((l) => !l.static)) {
    const variants = lesson.variants?.length ? lesson.variants : [{ label: '(default)' }];
    for (const variant of variants) {
      for (const provider of PROVIDERS.map((p) => p.id).filter((id) => !lesson.providers || lesson.providers.includes(id))) {
        runs++;
        const payload = { ...lesson.run, ...variant.run, provider, rules: variant.yaml ?? lesson.yaml };
        const res = await fetch(`http://localhost:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        const events = [...(await res.text()).matchAll(/event: (.*)\ndata: (.*)/g)].map(([, e, d]) => [e, JSON.parse(d)]);
        const error = events.find(([e]) => e === 'error')?.[1];
        const expectError = variant.expectError ?? lesson.expectError ?? false;
        const where = `${lesson.id} / ${variant.label} / ${provider}`;
        if (!events.some(([e]) => e === 'done')) failures.push(`${where}: run did not complete`);
        else if (error && /Scenario(Parse)?Error|PlaygroundError/.test(error.name)) failures.push(`${where}: ${error.name}: ${error.message}`);
        else if (error && /mock-llm internal error/i.test(error.message)) failures.push(`${where}: mock-llm internal error: ${error.message}`);
        else if (!!error !== expectError) failures.push(`${where}: expected ${expectError ? 'an error' : 'success'}, got ${error ? `${error.name}: ${error.message}` : 'success'}`);
        // Event ordering invariant (R4) for every request in every run.
        const mockEvents = events.filter(([e]) => e === 'mockevent').map(([, d]) => d);
        for (const id of new Set(mockEvents.map((d) => d.id))) {
          const seq = mockEvents.filter((d) => d.id === id).map((d) => d.name).join(' ');
          if (!/^request( unmatched)?( chunk)* (response|fault)$/.test(seq)) failures.push(`${where}: bad event order for request #${id}: ${seq}`);
        }
        if (events.some(([e]) => e === 'done') && !mockEvents.length) failures.push(`${where}: no mock events emitted`);
        // A lesson's rules must actually script its requests: an unmatched request means the
        // run silently fell back to the canned reply (e.g. a broken matcher). Opt out per variant.
        const allow = variant.allowUnmatched ?? lesson.allowUnmatched ?? false; // true, or a list of providers
        const allowUnmatched = allow === true || (Array.isArray(allow) && allow.includes(provider));
        if (!allowUnmatched && mockEvents.some((d) => d.name === 'unmatched')) failures.push(`${where}: a request matched no rule (lesson rules don't script it)`);
        const asserted = events.find(([e]) => e === 'assertions')?.[1]?.results;
        if (payload.assertions?.length) {
          const failed = (asserted ?? []).filter((r) => !r.pass);
          const expectFail = variant.expectAssertionFailure ?? lesson.expectAssertionFailure ?? false;
          if (!asserted) failures.push(`${where}: assertions were not evaluated`);
          else if (expectFail && !failed.length) failures.push(`${where}: expected an assertion to fail, all passed`);
          else if (!expectFail && failed.length) failures.push(`${where}: assertion failed: ${failed[0].label}\n${failed[0].message}`);
        }
      }
    }
  }
  // Every repo doc the Reference page links to (/docs/*.md) must be served.
  const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  const docLinks = [...new Set(app.match(/\/docs\/[\w-]+\.md/g))];
  for (const link of docLinks) {
    const res = await fetch(`http://localhost:${port}${link}`);
    if (res.status !== 200) failures.push(`Reference link ${link}: HTTP ${res.status}`);
  }
  if (!docLinks.length) failures.push('Reference page: no /docs links found');
} finally {
  server.kill();
}

console.log(`${runs} lesson runs, ${failures.length} failures`);
for (const f of failures) console.log(`  ✘ ${f}`);
process.exit(failures.length ? 1 : 0);
