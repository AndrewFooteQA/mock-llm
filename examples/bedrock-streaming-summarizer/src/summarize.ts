import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

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

export interface Summary {
  text: string;
  stopReason?: string;
  /** The model hit the length limit: the summary is cut short. */
  truncated: boolean;
}

/** One-shot summary with Bedrock Converse (no streaming), for batch jobs. */
export async function summarizeOnce(client: BedrockRuntimeClient, document: string, opts: { maxTokens?: number } = {}): Promise<Summary> {
  const r = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: document }] }],
      inferenceConfig: { maxTokens: opts.maxTokens ?? 512 },
    }),
  );
  const text = (r.output?.message?.content ?? []).map((b) => b.text ?? '').join('');
  return { text, stopReason: r.stopReason, truncated: r.stopReason === 'max_tokens' };
}

/**
 * The same summary through InvokeModel with Anthropic's native Messages body, as code written against the Claude API
 * (or the Anthropic Bedrock SDK) does.
 */
export async function summarizeWithInvokeModel(client: BedrockRuntimeClient, document: string, opts: { maxTokens?: number } = {}): Promise<Summary> {
  const r = await client.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: opts.maxTokens ?? 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: document }],
      }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(r.body)) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
  const text = body.content.flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : [])).join('');
  return { text, stopReason: body.stop_reason, truncated: body.stop_reason === 'max_tokens' };
}

/** Streamed summary through InvokeModelWithResponseStream: each chunk carries one native Claude stream event. */
export async function streamWithInvokeModel(client: BedrockRuntimeClient, document: string, onToken: (text: string) => void = () => {}): Promise<Summary> {
  const r = await client.send(
    new InvokeModelWithResponseStreamCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 512, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: document }] }),
    }),
  );
  let text = '';
  let stopReason: string | undefined;
  for await (const part of r.body!) {
    if (!part.chunk?.bytes) continue;
    const event = JSON.parse(new TextDecoder().decode(part.chunk.bytes));
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text;
      onToken(event.delta.text);
    }
    if (event.type === 'message_delta') stopReason = event.delta?.stop_reason ?? stopReason;
  }
  return { text, stopReason, truncated: stopReason === 'max_tokens' };
}
