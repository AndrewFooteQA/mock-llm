import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plan, supportedNodeLines } from '../../scripts/compat.mjs';

const targets = JSON.parse(readFileSync(new URL('../../compat/targets.json', import.meta.url), 'utf8'));

describe('compat/targets.json', () => {
  it('every target has a kind, packages, an x.y.z floor and the reason for it', () => {
    for (const [name, t] of Object.entries<any>(targets.targets)) {
      expect(['sdk', 'framework', 'playwright', 'peer', 'types'], name).toContain(t.kind);
      expect(t.packages[0], name).toBe(name);
      expect(t.oldest, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(t.floor, name).toBeTruthy();
    }
  });

  it('optional peer ranges in package.json match the tested floors', () => {
    const { peerDependencies } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const floor = (v: string) => v.replace(/^>=/, '').split('.').concat(['0', '0']).slice(0, 3).join('.');
    expect(floor(peerDependencies.vitest)).toBe(targets.targets.vitest.oldest);
    expect(floor(peerDependencies['@jest/globals'])).toBe(targets.targets.jest.oldest);
    expect(floor(peerDependencies['@playwright/test'])).toBe(targets.targets['@playwright/test'].oldest);
    expect(floor(peerDependencies.yaml)).toBe(targets.targets.yaml.oldest);
  });
});

describe('plan', () => {
  const file = { node: [22, 24, 26], targets: { a: { kind: 'sdk' }, b: { kind: 'sdk' }, v: { kind: 'framework' } } };
  it('smoke = each provider SDK at its oldest release, on the middle Node line', () => {
    expect(plan('smoke', file)).toEqual([
      { target: 'a', spec: 'oldest', node: 24 },
      { target: 'b', spec: 'oldest', node: 24 },
    ]);
  });
  it('full = every target at oldest and latest, plus everything-latest on every Node line', () => {
    const jobs = plan('full', file);
    expect(jobs).toHaveLength(3 * 2 + 3);
    expect(jobs).toContainEqual({ target: 'v', spec: 'latest', node: 24 });
    expect(jobs.filter((j) => j.target === 'all').map((j) => j.node)).toEqual([22, 24, 26]);
  });
  it('the real targets file plans without error', () => {
    expect(plan('full').length).toBeGreaterThan(plan('smoke').length);
  });
});

describe('supportedNodeLines (Node release schedule → lines to test)', () => {
  const schedule = {
    v20: { start: '2023-04-18', end: '2026-04-30' },
    v22: { start: '2024-04-24', end: '2027-04-30' },
    v23: { start: '2024-10-16', end: '2025-06-01' },
    v24: { start: '2025-05-06', end: '2028-04-30' },
    v26: { start: '2026-05-05', end: '2029-04-30' },
    v27: { start: '2026-10-20', end: '2027-06-01' },
    v28: { start: '2027-04-20', end: '2030-04-30' },
    'v0.12': { start: '2015-02-06', end: '2016-12-31' },
  };
  it('every even-numbered line between its release and end of life', () => {
    expect(supportedNodeLines(schedule, '2026-10-04')).toEqual([22, 24, 26]);
  });
  it('adds a line on release and drops one at end of life (the weekly issue fires on either)', () => {
    expect(supportedNodeLines(schedule, '2027-04-21')).toEqual([22, 24, 26, 28]);
    expect(supportedNodeLines(schedule, '2027-05-01')).toEqual([24, 26, 28]);
  });
});
