// The two `test.fail()` tests prove mock-llm's safety nets fail a test. A test.fail() also
// "passes" if it fails for some *other* reason (e.g. a timeout), so check the exact errors.
import { readFileSync } from 'node:fs';

const EXPECTED = {
  'without routeBrowser, a real provider call fails the test': /^Error: REAL LLM PROVIDER REQUEST BLOCKED/,
  'an unscripted LLM call fails the test even though the app shows a friendly error': /^UnmatchedRequestError: UNEXPECTED LLM REQUEST/,
};

const report = JSON.parse(readFileSync(new URL('../test-results/report.json', import.meta.url), 'utf8'));
const specs = [];
const walk = (suite) => {
  specs.push(...(suite.specs ?? []));
  (suite.suites ?? []).forEach(walk);
};
report.suites.forEach(walk);

let ok = true;
for (const [title, pattern] of Object.entries(EXPECTED)) {
  const errors = specs.find((s) => s.title === title)?.tests[0]?.results[0]?.errors.map((e) => e.message ?? '') ?? null;
  const pass = errors !== null && errors.length === 1 && pattern.test(errors[0]);
  ok &&= pass;
  console.log(`${pass ? '✔' : '✘'} "${title}" failed ${pass ? 'for the expected reason' : `unexpectedly: ${JSON.stringify(errors)}`}`);
}
process.exit(ok ? 0 : 1);
