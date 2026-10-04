import OpenAI from 'openai';

export const SYSTEM_PROMPT = 'You are the support assistant for Acme Store. Be concise and friendly.';

export type Answer =
  | { kind: 'answer'; text: string }
  | { kind: 'refusal'; text: string }
  | { kind: 'truncated'; text: string }
  | { kind: 'unavailable'; text: string }
  | { kind: 'too_long'; text: string };

/**
 * A small customer-support bot. The interesting part isn't the happy path. It's
 * how it handles refusals, truncation, outages and untrusted model output.
 */
export class SupportBot {
  constructor(
    private readonly client: OpenAI = new OpenAI(),
    private readonly model = 'gpt-4o',
  ) {}

  async answer(question: string): Promise<Answer> {
    let completion: OpenAI.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
      });
    } catch (err) {
      // The question didn't fit the model's context window: ask the user to shorten it.
      if (err instanceof OpenAI.BadRequestError && err.code === 'context_length_exceeded') {
        return { kind: 'too_long', text: 'Your message is too long. Please shorten it and try again.' };
      }
      // Rate limits, outages, timeouts and dropped connections all extend APIError.
      if (err instanceof OpenAI.APIError) {
        return { kind: 'unavailable', text: 'Our assistant is busy right now. Please try again in a moment.' };
      }
      throw err;
    }

    const choice = completion.choices[0]!;
    if (choice.message.refusal) {
      return { kind: 'refusal', text: "Sorry, I can't help with that. A human agent will follow up." };
    }
    const text = escapeHtml(choice.message.content ?? '');
    if (choice.finish_reason === 'length') return { kind: 'truncated', text: `${text}…` };
    return { kind: 'answer', text };
  }
}

/** Model output is untrusted: escape it before it reaches a web page. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
