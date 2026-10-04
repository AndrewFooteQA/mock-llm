import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Jest can't load our TS sources, so these tests exercise the *built* package, as users get it.
beforeAll(() => {
  const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
}, 120_000);

function runJest() {
  const dir = mkdtempSync(join(tmpdir(), 'mock-llm-jest-'));
  const outputFile = join(dir, 'report.json');
  const run = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'tests/fixtures/jest/jest.config.mjs', '--json', `--outputFile=${outputFile}`],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const report = JSON.parse(readFileSync(outputFile, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  const tests: Record<string, { status: string; failureMessages: string[] }> = {};
  for (const file of report.testResults) for (const t of file.assertionResults) tests[t.title] = t;
  return { status: run.status, tests, stderr: run.stderr };
}

describe('mock-llm/jest (Jest 30, ESM mode)', () => {
  it('registers working matchers, strict mode, and leaves spy matchers alone', () => {
    const { status, tests } = runJest();
    expect(tests['pass, negate, and fail with the journal excerpt']?.status).toBe('passed');
    expect(tests["leaves Jest's built-in spy matchers alone"]?.status).toBe('passed');
    expect(tests['scripted request passes']?.status).toBe('passed');
    // Strict mode fails the test whose app hid the error:
    expect(tests['unscripted request is swallowed by the app']?.status).toBe('failed');
    expect(tests['unscripted request is swallowed by the app']?.failureMessages.join('\n')).toContain('UNEXPECTED LLM REQUEST');
    expect(status).toBe(1); // …and only that test failed the run
    expect(Object.values(tests).filter((t) => t.status === 'failed')).toHaveLength(1);
  }, 120_000);
});

describe('optional framework dependencies', () => {
  it("importing 'mock-llm' never loads jest or vitest", () => {
    // Walk the relative-import graph of the package entry in dist/.
    const seen = new Set<string>();
    const staticBare = new Set<string>();
    const dynamicBare = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const [, fromSpec, dynamicSpec] of src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = fromSpec ?? dynamicSpec!;
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
        else (fromSpec ? staticBare : dynamicBare).add(spec);
      }
    };
    visit(resolve('dist/index.js'));
    expect(seen.size).toBeGreaterThan(10);
    expect([...staticBare, ...dynamicBare].filter((s) => /jest|vitest/.test(s))).toEqual([]);
    // Zero runtime dependencies: static imports are Node built-ins only…
    expect([...staticBare].filter((s) => !s.startsWith('node:'))).toEqual([]);
    // …and the only optional, lazily loaded package is `yaml` (for YAML scenario files).
    expect([...dynamicBare]).toEqual(['yaml']);
  });
});
