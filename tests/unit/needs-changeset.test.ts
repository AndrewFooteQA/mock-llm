import { describe, expect, it } from 'vitest';
import { shippedChanges } from '../../scripts/needs-changeset.mjs';

const pkg = { name: 'mock-llm', exports: { '.': './dist/index.js' }, peerDependencies: { vitest: '>=4.0.1' }, devDependencies: { openai: '^7.25.0' }, scripts: { test: 'vitest' } };

describe('needs-changeset: only changes that ship need a changeset', () => {
  it('a Renovate lockfile / devDependency update does not (regression: Renovate PR #5 failed CI)', () => {
    const head = { ...pkg, devDependencies: { openai: '^7.28.0' } };
    expect(shippedChanges(['package-lock.json', 'examples/openai-support-bot/package-lock.json', 'package.json'], pkg, head)).toEqual([]);
  });
  it('tests, docs, scripts and workflows do not', () => {
    expect(shippedChanges(['tests/contract/openai.test.ts', 'README.md', 'scripts/compat.mjs', '.github/workflows/ci.yml'], pkg, { ...pkg, scripts: { test: 'x' } })).toEqual([]);
  });
  it('src/ changes and release fields of package.json do', () => {
    expect(shippedChanges(['src/mock.ts'], pkg, pkg)).toEqual(['src/mock.ts changed']);
    expect(shippedChanges(['package.json'], pkg, { ...pkg, peerDependencies: { vitest: '>=5' } })).toEqual(['package.json "peerDependencies" changed']);
    expect(shippedChanges(['package.json'], pkg, { ...pkg, engines: { node: '>=24' } })).toEqual(['package.json "engines" changed']);
  });
});
