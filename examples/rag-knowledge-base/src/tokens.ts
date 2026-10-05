import type Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, CountTokensCommand } from '@aws-sdk/client-bedrock-runtime';
import type { GoogleGenAI } from '@google/genai';

/** Count a prompt's input tokens with the provider's own endpoint, before sending it. */
export type TokenCounter = (system: string, user: string) => Promise<number>;

export const anthropicCounter = (client: Anthropic, model: string): TokenCounter => async (system, user) =>
  (await client.messages.countTokens({ model, system, messages: [{ role: 'user', content: user }] })).input_tokens;

export const geminiCounter = (ai: GoogleGenAI, model: string): TokenCounter => async (system, user) =>
  (await ai.models.countTokens({ model, contents: `${system}\n\n${user}` })).totalTokens ?? 0;

export const bedrockCounter = (client: BedrockRuntimeClient, modelId: string): TokenCounter => async (system, user) =>
  (
    await client.send(
      new CountTokensCommand({ modelId, input: { converse: { system: [{ text: system }], messages: [{ role: 'user', content: [{ text: user }] }] } } }),
    )
  ).inputTokens ?? 0;
