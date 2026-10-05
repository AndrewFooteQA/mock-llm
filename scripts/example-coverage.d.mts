// Types for tests/unit/example-coverage.test.ts (the script itself is plain JS).
export type Feature = { area: string; label: string; patterns: RegExp[] };
export type Row = { id: string; area: string; label: string; status: 'covered' | 'exempt' | 'uncovered'; examples: string[]; files: string[]; reason?: string };
export type Config = { surface?: Record<string, { label?: string; patterns: string | string[] }>; required?: string[]; exempt?: Record<string, string> };
export function maskStrings(text: string): string;
export function blockAfter(text: string, start: RegExp): string;
export function topLevelKeys(body: string): string[];
export function exportedValues(text: string): string[];
export function stringArray(text: string, name: string): string[];
export function buildInventory(read: (path: string) => string): Map<string, Feature>;
export function scan(features: Map<string, Feature>, sources: Record<string, Record<string, string>>): Map<string, Array<{ example: string; files: string[] }>>;
export function evaluate(inventory: Map<string, Feature>, config: Config, sources: Record<string, Record<string, string>>): { rows: Row[]; problems: string[] };
