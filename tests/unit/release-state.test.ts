import { describe, expect, it } from 'vitest';
import { onNpm, publishedNow } from '../../scripts/release-state.mjs';

describe('release state (did this run publish?)', () => {
  it('published now = absent before the publish step and present after, whatever the step reported', () => {
    expect(publishedNow(false, true)).toBe(true); // 0.2.2: published, then a GitHub API timeout failed the step
    expect(publishedNow(true, true)).toBe(false); // an ordinary push: the version was already out
    expect(publishedNow(false, false)).toBe(false); // the publish itself failed
  });

  it('waits for a just-published version to propagate, up to the attempt limit', async () => {
    const seen: string[] = [];
    let calls = 0;
    const view = (spec: string) => (seen.push(spec), ++calls >= 3 ? '0.2.2' : '');
    expect(await onNpm('mock-llm', '0.2.2', { attempts: 5, waitMs: 1, view, sleep: async () => {} })).toBe(true);
    expect(seen).toEqual(['mock-llm@0.2.2', 'mock-llm@0.2.2', 'mock-llm@0.2.2']);
    calls = -100;
    expect(await onNpm('mock-llm', '0.2.2', { attempts: 2, waitMs: 1, view, sleep: async () => {} })).toBe(false);
  });
});
