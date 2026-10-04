import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { useMockLLM } from '../../src/testing/vitest.js';

const mock = useMockLLM();
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('mock.env() points unmodified SDK clients at the mock', () => {
  it('all four SDKs, configured only through environment variables', async () => {
    Object.assign(process.env, mock.env());
    delete process.env.AWS_PROFILE;
    mock.when({}).replyTemplate('hello {{provider}}');

    const openai = await new OpenAI().chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    const claude = await new Anthropic().messages.create({ model: 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
    const gemini = await new GoogleGenAI({}).models.generateContent({ model: 'gemini-2.5-flash', contents: 'x' });
    const bedrock = await new BedrockRuntimeClient({}).send(
      new ConverseCommand({ modelId: 'anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text: 'x' }] }] }),
    );

    expect(openai.choices[0]!.message.content).toBe('hello openai');
    expect(claude.content[0]).toMatchObject({ text: 'hello anthropic' });
    expect(gemini.text).toBe('hello gemini');
    expect(bedrock.output!.message!.content![0]!.text).toBe('hello bedrock');
  });
});
