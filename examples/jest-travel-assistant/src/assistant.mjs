import OpenAI from 'openai';

export const INSTRUCTIONS = 'You are a concise travel assistant. Use tools for live data.';

const TOOLS = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    strict: true,
  },
  {
    type: 'function',
    name: 'convert_currency',
    description: 'Convert an amount between currencies',
    parameters: {
      type: 'object',
      properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['amount', 'from', 'to'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const RATES = { 'EUR:USD': 1.1, 'USD:EUR': 0.91 };
const runTool = (name, args) => {
  if (name === 'get_weather') return { city: args.city, tempC: 19, conditions: 'cloudy' };
  if (name === 'convert_currency') return { amount: Math.round(args.amount * (RATES[`${args.from}:${args.to}`] ?? 1) * 100) / 100, currency: args.to };
  return { error: `Unknown tool: ${name}` };
};

/**
 * A travel assistant on the OpenAI Responses API: tool loop via previous_response_id,
 * conversation memory across questions, and a friendly message instead of API errors.
 */
export class TravelAssistant {
  #client;
  #model;
  #lastResponseId;

  constructor(client = new OpenAI(), { model = 'gpt-4.1' } = {}) {
    this.#client = client;
    this.#model = model;
  }

  async ask(question, { maxTurns = 4 } = {}) {
    const toolsUsed = [];
    let input = question;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const response = await this.#client.responses.create({
          model: this.#model,
          instructions: INSTRUCTIONS,
          tools: TOOLS,
          input,
          ...(this.#lastResponseId && { previous_response_id: this.#lastResponseId }),
        });
        this.#lastResponseId = response.id;

        const refusal = response.output.flatMap((o) => (o.type === 'message' ? o.content : [])).find((p) => p.type === 'refusal');
        if (refusal) return { text: "Sorry, I can't help with that one.", toolsUsed, refused: true };

        const calls = response.output.filter((o) => o.type === 'function_call');
        if (!calls.length) return { text: response.output_text, toolsUsed };

        input = calls.map((call) => {
          toolsUsed.push(call.name);
          return { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(runTool(call.name, JSON.parse(call.arguments))) };
        });
      }
      return { text: 'Sorry, that took too many steps.', toolsUsed };
    } catch (err) {
      if (err instanceof OpenAI.APIError) return { text: 'The travel assistant is unavailable right now.', toolsUsed, unavailable: true };
      throw err;
    }
  }
}
