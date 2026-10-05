import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { GoogleGenAI } from '@google/genai';
import type OpenAI from 'openai';

/** Anything that turns texts into vectors. One implementation per provider SDK. */
export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI embeddings. The SDK requests base64 by default and decodes it to float arrays for you;
 * `encoding_format: 'float'` asks the API for plain JSON numbers instead. Both give the same vectors.
 */
export function openaiEmbedder(client: OpenAI, opts: { model?: string; encoding?: 'base64' | 'float' } = {}): Embedder {
  const { model = 'text-embedding-3-small', encoding } = opts;
  return {
    name: `openai/${model}${encoding ? ` (${encoding})` : ''}`,
    async embed(texts) {
      const r = await client.embeddings.create({ model, input: texts, ...(encoding && { encoding_format: encoding }) });
      return [...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
    },
  };
}

/** Gemini embeddings: AI Studio (API key) or Vertex AI, depending on how `ai` was created. One batch call. */
export function geminiEmbedder(ai: GoogleGenAI, opts: { model?: string; dimensions?: number } = {}): Embedder {
  const { model = 'gemini-embedding-001', dimensions } = opts;
  return {
    name: `gemini/${model}`,
    async embed(texts) {
      const r = await ai.models.embedContent({ model, contents: texts, ...(dimensions && { config: { outputDimensionality: dimensions } }) });
      return (r.embeddings ?? []).map((e) => e.values ?? []);
    },
  };
}

/** Bedrock Titan Text Embeddings v2 via InvokeModel: one text per call. */
export function bedrockTitanEmbedder(client: BedrockRuntimeClient, opts: { modelId?: string; dimensions?: number } = {}): Embedder {
  const { modelId = 'amazon.titan-embed-text-v2:0', dimensions = 512 } = opts;
  return {
    name: `bedrock/${modelId}`,
    async embed(texts) {
      const out: number[][] = [];
      for (const inputText of texts) {
        const r = await client.send(
          new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ inputText, dimensions, normalize: true }) }),
        );
        out.push(JSON.parse(new TextDecoder().decode(r.body)).embedding);
      }
      return out;
    },
  };
}
