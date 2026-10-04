// Types for tests/unit/compat.test.ts (the script itself is plain JS).
export type Job = { target: string; spec: 'oldest' | 'latest' | 'all-latest'; node: number };
export function plan(kind: 'smoke' | 'full', file?: { node: number[]; targets: Record<string, { kind: string }> }): Job[];
export function supportedNodeLines(schedule: Record<string, { start: string; end: string }>, today: string): number[];
