// Types for tests/unit/release-state.test.ts (the script itself is plain JS).
export function onNpm(name: string, version: string, opts?: { attempts?: number; waitMs?: number; view?: (spec: string) => string; sleep?: (ms: number) => Promise<void> }): Promise<boolean>;
export function publishedNow(existedBefore: boolean, existsAfter: boolean): boolean;
