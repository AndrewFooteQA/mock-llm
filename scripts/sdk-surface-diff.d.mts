// Types for tests/unit/sdk-surface-diff.test.ts (the script itself is plain JS).
export type Symbols = Map<string, { kind: string; members: Set<string> }>;
export const SURFACES: Record<string, RegExp[]>;
export function parseDeclarations(text: string): Symbols;
export function diffSurfaces(a: Symbols, b: Symbols): { added: string[]; removed: string[]; changed: { name: string; added: string[]; removed: string[] }[] };
export function markdown(pkg: string, from: string, to: string, a: { files: string[] }, b: { files: string[] }, d: ReturnType<typeof diffSurfaces>): string;
