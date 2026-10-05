// Types for tests/unit/playground-runs.test.ts (runs.js is plain browser/Node ESM).
export const PG_DEFAULT: Record<string, unknown>;
export function playgroundPayload(v: Record<string, unknown>): Record<string, unknown>;
export function lessonPayload(lesson: Record<string, any>, variant: Record<string, any> | undefined, provider: string): Record<string, unknown>;
export function enumerateRuns(): Array<{ where: string; provider: string; payload: Record<string, unknown>; playground?: boolean; lesson?: any; variant?: any }>;
export function canonicalJson(value: unknown): string;
export function runKey(payload: unknown): Promise<string>;
