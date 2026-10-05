import type Anthropic from '@anthropic-ai/sdk';
import type { Embedder } from './embedders.js';
import type { TokenCounter } from './tokens.js';

export interface Doc {
  id: string;
  /** What gets embedded and matched against questions (e.g. an FAQ question). */
  key: string;
  /** What goes into the prompt when the doc is retrieved. */
  text: string;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** A tiny in-memory vector index. */
export class KnowledgeBase {
  #docs: Array<Doc & { vector: number[] }> = [];
  constructor(private embedder: Embedder) {}

  async add(docs: Doc[]): Promise<void> {
    const vectors = await this.embedder.embed(docs.map((d) => d.key));
    docs.forEach((d, i) => this.#docs.push({ ...d, vector: vectors[i]! }));
  }

  async search(query: string, k = 3): Promise<Array<Doc & { score: number }>> {
    const [q] = await this.embedder.embed([query]);
    return this.#docs
      .map(({ vector, ...d }) => ({ ...d, score: cosine(q!, vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

export const SYSTEM_PROMPT = 'Answer using only the passages provided. If they do not contain the answer, say so.';

/** Pick the newest Sonnet the API lists, falling back to any Claude model. */
export async function pickModel(client: Anthropic): Promise<string> {
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  const model = ids.find((id) => id.includes('sonnet')) ?? ids.find((id) => id.startsWith('claude-'));
  if (!model) throw new Error('No Claude model available');
  return model;
}

export interface Answer {
  text: string;
  model: string;
  passages: string[];
  promptTokens: number;
}

/**
 * Retrieval-augmented answer: retrieve the top passages, drop the lowest-ranked ones until the prompt fits the
 * token budget (counted by the provider before sending), then ask Claude.
 */
export async function answer(
  kb: KnowledgeBase,
  client: Anthropic,
  question: string,
  opts: { countTokens?: TokenCounter; maxPromptTokens?: number; k?: number; model?: string } = {},
): Promise<Answer> {
  const model = opts.model ?? (await pickModel(client));
  const { countTokens, maxPromptTokens = 2_000, k = 3 } = opts;
  let passages = (await kb.search(question, k)).map((d) => d.text);
  const prompt = () => `Passages:\n${passages.map((p, i) => `[${i + 1}] ${p}`).join('\n')}\n\nQuestion: ${question}`;

  let promptTokens = countTokens ? await countTokens(SYSTEM_PROMPT, prompt()) : 0;
  while (countTokens && promptTokens > maxPromptTokens && passages.length > 1) {
    passages = passages.slice(0, -1);
    promptTokens = await countTokens(SYSTEM_PROMPT, prompt());
  }

  const message = await client.messages.create({ model, max_tokens: 512, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt() }] });
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return { text, model, passages, promptTokens };
}
