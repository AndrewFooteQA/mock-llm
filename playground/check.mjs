// Runs every tutorial run (each lesson × variant × provider, plus the Playground page's default form on each provider)
// through the playground server and verifies each run completes, and errors exactly when the lesson says it should
// (`expectError`). Run after changing the library, the lessons or the server.
//   npm run playground:check
//   npm run playground:record   (= --record playground/.recordings: also saves each run's events with their timing,
//                                for the static GitHub Pages build, and fails if any run is left without a recording)
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateRuns, runKey } from './public/runs.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const recordIndex = process.argv.indexOf('--record');
const target = recordIndex === -1 ? null : process.argv[recordIndex + 1];
// Record into a directory of our own and swap it into place at the end, so two checks running at once (e.g. a
// hook's and yours) can't delete each other's recordings mid-run.
const recordDir = target && `${target}.tmp-${process.pid}`;
const version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
if (recordDir) {
  rmSync(recordDir, { recursive: true, force: true });
  mkdirSync(recordDir, { recursive: true });
}
const server = spawn(process.execPath, ['server.mjs'], { cwd: here, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const [line] = await once(server.stdout, 'data');
const port = String(line).match(/localhost:(\d+)/)?.[1];
if (!port) throw new Error(`playground server did not start: ${line}`);

/** POST a run and collect its SSE events, each with the ms offset it arrived at. */
async function runOnce(payload) {
  const started = performance.now();
  const res = await fetch(`http://localhost:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const timed = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev) timed.push([Math.round(performance.now() - started), ev, data ? JSON.parse(data) : {}]);
    }
  }
  return timed;
}

const failures = [];
const recorded = [];
let runs = 0;
try {
  for (const { where, lesson = {}, variant = {}, provider, payload } of enumerateRuns()) {
    runs++;
    const timed = await runOnce(payload);
    const events = timed.map(([, e, d]) => [e, d]);
    if (recordDir) {
      const file = join(recordDir, `${await runKey(payload)}.json`);
      writeFileSync(file, JSON.stringify({ where, version, recordedAt: new Date().toISOString(), payload, events: timed }));
      recorded.push(file);
    }
    const error = events.find(([e]) => e === 'error')?.[1];
    const expectError = variant.expectError ?? lesson.expectError ?? false;
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
  // Every repo doc the Reference page links to (/docs/*.md) must be served.
  const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  const docLinks = [...new Set(app.match(/"docs\/[\w-]+\.md/g))].map((l) => l.slice(1));
  if (/href="\//.test(app)) failures.push('Reference page: root-absolute link (href="/…") breaks under the Pages subpath; use a relative one');
  for (const link of docLinks) {
    const res = await fetch(`http://localhost:${port}/${link}`);
    if (res.status !== 200) failures.push(`Reference link ${link}: HTTP ${res.status}`);
  }
  if (!docLinks.length) failures.push('Reference page: no /docs links found');
  // No silent gaps on the static site: every run the tutorial offers has a recording.
  if (recordDir) {
    for (const { where, payload } of enumerateRuns()) {
      if (!existsSync(join(recordDir, `${await runKey(payload)}.json`))) failures.push(`${where}: no recording`);
    }
  }
} finally {
  server.kill();
}
if (recordDir) {
  if (failures.length) rmSync(recordDir, { recursive: true, force: true });
  else {
    rmSync(target, { recursive: true, force: true });
    renameSync(recordDir, target);
  }
}

console.log(`${runs} lesson runs, ${failures.length} failures${target ? ` (${recorded.length} recordings${failures.length ? ' discarded' : ` in ${target}`})` : ''}`);
for (const f of failures) console.log(`  ✘ ${f}`);
process.exit(failures.length ? 1 : 0);
