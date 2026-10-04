import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

export const MODEL_ID = 'us.anthropic.claude-sonnet-5-5';
export const SYSTEM_PROMPT = 'Summarize the document in three sentences.';

/** Thrown when the stream breaks partway; carries whatever text arrived first. */
export class SummaryInterrupted extends Error {
  constructor(
    readonly partial: string,
    readonly cause: unknown,
  ) {
    super(`Summary interrupted after ${partial.length} characters: ${(cause as Error)?.name ?? cause}`);
  }
}

/**
 * Stream a summary with Bedrock ConverseStream, calling onToken for each text
 * delta (e.g. to update a UI). Mid-stream failures keep the partial text.
 */
export async function summarize(
  client: BedrockRuntimeClient,
  document: string,
  onToken: (text: string) => void = () => {},
): Promise<{ text: string; stopReason?: string; outputTokens?: number }> {
  const response = await client.send(
    new ConverseStreamCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: document }] }],
      inferenceConfig: { maxTokens: 512 },
    }),
  );

  let text = '';
  let stopReason: string | undefined;
  let outputTokens: number | undefined;
  try {
    for await (const event of response.stream!) {
      const delta = event.contentBlockDelta?.delta?.text;
      if (delta) {
        text += delta;
        onToken(delta);
      }
      stopReason = event.messageStop?.stopReason ?? stopReason;
      outputTokens = event.metadata?.usage?.outputTokens ?? outputTokens;
    }
  } catch (err) {
    throw new SummaryInterrupted(text, err);
  }
  return { text, stopReason, outputTokens };
}
