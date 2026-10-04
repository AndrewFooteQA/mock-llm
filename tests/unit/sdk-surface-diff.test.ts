import { describe, expect, it } from 'vitest';
import { diffSurfaces, markdown, parseDeclarations, SURFACES } from '../../scripts/sdk-surface-diff.mjs';

// Shaped like real SDK declaration files (openai / @anthropic-ai/sdk / @google/genai .d.ts).
const V1 = `
/** A content block. */
export type ContentBlock = TextBlock | ToolUseBlock;
export type StopReason = 'end_turn' | 'max_tokens'
  | 'tool_use';
export interface TextBlock {
  text: string;
  /** citations */
  citations?: Array<TextCitation> | null;
  type: 'text';
}
export declare namespace Messages {
  export interface MessageCreateParams {
    model: string;
    max_tokens: number;
    stream?: boolean;
  }
}
export declare class APIError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined, error: object | undefined);
  static generate(status: number): APIError;
}
export type Usage = { input_tokens: number; output_tokens: number };
`;
const V2 = `
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;
export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal';
export interface TextBlock {
  text: string;
  type: 'text';
}
export interface ThinkingBlock {
  thinking: string;
  signature: string;
}
export declare namespace Messages {
  export interface MessageCreateParams {
    model: string;
    max_tokens: number;
    stream?: boolean;
    thinking?: { type: 'adaptive' };
  }
}
export declare class APIError extends Error {
  readonly status: number | undefined;
  readonly requestID: string | null;
  constructor(status: number | undefined, error: object | undefined);
  static generate(status: number): APIError;
}
export type Usage = { input_tokens: number; output_tokens: number };
`;

describe('parseDeclarations', () => {
  const s = parseDeclarations(V1);
  it('reads union members and string literals of type aliases, across lines', () => {
    expect([...s.get('ContentBlock')!.members]).toEqual(['TextBlock', 'ToolUseBlock']);
    expect([...s.get('StopReason')!.members].sort()).toEqual(["'end_turn'", "'max_tokens'", "'tool_use'"]);
  });
  it('reads interface members, ignoring JSDoc', () => {
    expect([...s.get('TextBlock')!.members]).toEqual(['text', 'citations', 'type', "type:'text'"]);
  });
  it('qualifies declarations inside namespaces', () => {
    expect([...s.get('Messages.MessageCreateParams')!.members]).toEqual(['model', 'max_tokens', 'stream']);
    expect(s.has('MessageCreateParams')).toBe(false);
  });
  it('reads class members, marking methods', () => {
    expect([...s.get('APIError')!.members]).toEqual(['status', 'constructor()', 'generate()']);
  });
});

describe('member literal types (regression: openai 7.28.0 added detail: \'original\' unnoticed)', () => {
  const before = `export interface ImageURL {\n  url: string;\n  detail?: 'auto' | 'low' | 'high';\n}`;
  const after = `export interface ImageURL {\n  url: string;\n  detail?: 'auto' | 'low' | 'high' | 'original';\n}`;
  it('records each string literal of a member type as member:literal', () => {
    expect([...parseDeclarations(before).get('ImageURL')!.members]).toEqual(['url', 'detail', "detail:'auto'", "detail:'low'", "detail:'high'"]);
  });
  it('a literal added to a member type shows up in the diff', () => {
    expect(diffSurfaces(parseDeclarations(before), parseDeclarations(after)).changed).toEqual([{ name: 'ImageURL', added: ["detail:'original'"], removed: [] }]);
  });
});

describe('diffSurfaces + markdown', () => {
  const d = diffSurfaces(parseDeclarations(V1), parseDeclarations(V2));
  it('lists added and removed types, and members added/removed per type', () => {
    expect(d.added).toEqual(['ThinkingBlock']);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([
      { name: 'APIError', added: ['requestID'], removed: [] },
      { name: 'ContentBlock', added: ['ThinkingBlock'], removed: [] },
      { name: 'Messages.MessageCreateParams', added: ['thinking', "thinking:'adaptive'"], removed: [] },
      { name: 'StopReason', added: ["'refusal'"], removed: [] },
      { name: 'TextBlock', added: [], removed: ['citations'] },
    ]);
  });
  it('renders Markdown that flags wire-relevant names', () => {
    const md = markdown('@anthropic-ai/sdk', '1.0.0', '1.1.0', { files: ['a.d.ts'] }, { files: ['a.d.ts'] }, d);
    expect(md).toContain('### `@anthropic-ai/sdk` 1.0.0 → 1.1.0');
    expect(md).toContain("- `StopReason` 🔎: +`'refusal'`");
    expect(md).toContain('- `TextBlock` 🔎: −`citations`');
    expect(md).toContain('**Added types (1)**\n- `ThinkingBlock` 🔎');
  });
  it('says so when the SDK layout no longer matches the surface patterns', () => {
    const md = markdown('openai', '1', '2', { files: [] }, { files: [] }, diffSurfaces(new Map(), new Map()));
    expect(md).toContain('No declaration files matched');
  });
  it('has a surface definition for every provider SDK in the compatibility matrix', async () => {
    const { targets } = (await import('../../compat/targets.json', { with: { type: 'json' } })).default as any;
    const sdks = Object.entries(targets).filter(([, t]: any) => t.kind === 'sdk').map(([n]) => n);
    expect(Object.keys(SURFACES).sort()).toEqual(sdks.sort());
  });
});
