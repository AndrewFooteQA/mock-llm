// Runs the deliberately failing tests in test/should-fail/ and checks they fail for the expected reasons.
// (A test that is *expected* to fail would also "pass" if it failed for another reason, so check the messages.)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const out = new URL('../test-results/should-fail.json', import.meta.url);
const run = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.should-fail.config.ts', '--reporter=json', `--outputFile=${fileURLToPath(out)}`], { cwd: dir, encoding: 'utf8' });

const EXPECTED = {
  'an unmet expectation step and an unscripted request both fail the test, though the bot hides them': [
    /SCENARIO EXPECTATION FAILED: 1 expectation\(s\) not met/,
    /rules\[0\] \("refund"\) › steps\[0\]: expectRequest/,
    /UNEXPECTED LLM REQUEST/,
    /Where is my order\?/,
  ],
};

const report = JSON.parse(readFileSync(out, 'utf8'));
const results = report.testResults.flatMap((f) => f.assertionResults);
let ok = run.status !== 0;
if (!ok) console.log('✘ the should-fail suite passed');
for (const [title, patterns] of Object.entries(EXPECTED)) {
  const r = results.find((a) => a.title === title);
  const message = (r?.failureMessages ?? []).join('\n');
  const missing = patterns.filter((p) => !p.test(message));
  const pass = r?.status === 'failed' && !missing.length;
  ok &&= pass;
  console.log(`${pass ? '✔' : '✘'} "${title}" failed ${pass ? 'for the expected reasons' : `unexpectedly (status ${r?.status}; missing ${missing.join(', ')}):\n${message}`}`);
}
process.exit(ok ? 0 : 1);
