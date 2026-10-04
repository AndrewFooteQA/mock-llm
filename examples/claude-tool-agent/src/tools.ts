import type Anthropic from '@anthropic-ai/sdk';

const ORDERS: Record<string, { status: string; eta: string }> = {
  'A-1001': { status: 'shipped', eta: '2026-10-08' },
  'A-1002': { status: 'processing', eta: '2026-10-12' },
};

export interface Tool {
  definition: Anthropic.Tool;
  run(input: Record<string, unknown>): unknown;
}

export class ToolInputError extends Error {}

export const tools: Record<string, Tool> = {
  lookup_order: {
    definition: {
      name: 'lookup_order',
      description: 'Look up the status of an order by id',
      input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    },
    run(input) {
      if (typeof input.order_id !== 'string') throw new ToolInputError(`order_id must be a string, got ${JSON.stringify(input.order_id)}`);
      return ORDERS[input.order_id] ?? { error: `No order ${input.order_id}` };
    },
  },
  get_weather: {
    definition: {
      name: 'get_weather',
      description: 'Current weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    run(input) {
      if (typeof input.city !== 'string') throw new ToolInputError(`city must be a string, got ${JSON.stringify(input.city)}`);
      return { city: input.city, tempC: 18, conditions: 'cloudy' };
    },
  },
};
