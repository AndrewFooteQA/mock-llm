import Anthropic from '@anthropic-ai/sdk';
import { tools as defaultTools, ToolInputError, type Tool } from './tools.js';

export class AgentError extends Error {}

export interface AgentResult {
  answer: string;
  turns: number;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean }>;
}

/**
 * A minimal manual tool-use loop: call Claude, run any requested tools, send
 * every result back in ONE user message, repeat until Claude stops asking.
 */
export async function runAgent(
  client: Anthropic,
  question: string,
  opts: { model?: string; maxTurns?: number; tools?: Record<string, Tool> } = {},
): Promise<AgentResult> {
  const { model = 'claude-opus-5-5', maxTurns = 5, tools = defaultTools } = opts;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const toolCalls: AgentResult['toolCalls'] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const message = await client.messages.create({
      model,
      max_tokens: 4096,
      system: 'You are a helpful shopping assistant. Use tools when needed.',
      tools: Object.values(tools).map((t) => t.definition),
      messages,
    });

    if (message.stop_reason === 'refusal') throw new AgentError('The model declined this request.');
    if (message.stop_reason !== 'tool_use') {
      const answer = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { answer, turns: turn, toolCalls };
    }

    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const tool = tools[block.name];
      let content: string;
      let ok = true;
      try {
        if (!tool) throw new ToolInputError(`Unknown tool: ${block.name}`);
        content = JSON.stringify(tool.run(block.input as Record<string, unknown>));
      } catch (err) {
        if (!(err instanceof ToolInputError)) throw err;
        ok = false;
        content = `Error: ${err.message}`; // tell the model what went wrong so it can recover
      }
      toolCalls.push({ name: block.name, input: block.input, ok });
      results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: !ok });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new AgentError(`Agent did not finish within ${maxTurns} turns`);
}
