import type { IRContent, IRRequest } from './types.js';

/**
 * Approximate token count (~4 chars per token). Real tokenizers differ per
 * provider; this is deliberately cheap and deterministic, good enough for
 * usage/budget assertions in tests.
 */
export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function requestTokens(req: IRRequest): number {
  let text = req.system ?? '';
  for (const m of req.messages) {
    for (const p of m.content) {
      if (p.type === 'text' || p.type === 'thinking') text += p.text;
      else if (p.type === 'tool_call') text += p.name + JSON.stringify(p.input ?? {});
      else if (p.type === 'tool_result') text += p.content;
      else if (p.type === 'image') text += ' '.repeat(4 * 256);
    }
  }
  if (req.tools.length) text += JSON.stringify(req.tools);
  return approxTokens(text);
}

export function contentTokens(content: IRContent[]): number {
  let text = '';
  for (const c of content) {
    if (c.type === 'text' || c.type === 'thinking') text += c.text;
    else text += c.name + (typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}));
  }
  return approxTokens(text);
}

/** The stream pieces for a text block: its explicit `chunks` if given, otherwise word-ish pieces. */
export function textPieces(c: { text: string; chunks?: string[] }): string[] {
  return c.chunks?.length ? c.chunks : chunkText(c.text);
}

/** Split text into small stream chunks (word-ish pieces, whitespace kept). */
export function chunkText(text: string, wordsPerChunk = 1): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(''));
  }
  return chunks.length ? chunks : [''];
}
