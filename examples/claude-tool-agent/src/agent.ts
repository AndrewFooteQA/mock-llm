import Anthropic from '@anthropic-ai/sdk';
import { tools as defaultTools, ToolInputError, type Tool } from './tools.js';

export class AgentError extends Error {}

export interface AgentResult {
  answer: string;
  turns: number;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean }>;
}

export interface AgentOptions {
  model?: string;
  maxTurns?: number;
  tools?: Record<string, Tool>;
  /** Stream each turn with `messages.stream()`; `onText` receives the answer's text as it arrives. */
  stream?: boolean;
  onText?: (delta: string) => void;
  /** Diagnostics, e.g. the model's reasoning. It is never part of the answer shown to users. */
  log?: (line: string) => void;
  /**
   * Quick mode for live chat: fast inference and no up-front thinking. Where the model offers it, thinking is
   * `between_tools`, so the only thinking blocks are short progress updates, passed to `onStatus` for the UI.
   */
  quick?: boolean;
  onStatus?: (update: string) => void;
}

/** How quick mode should think on this model, read from the Models API (as Anthropic recommends) before the first call. */
async function quickThinking(client: Anthropic, model: string, log?: (line: string) => void): Promise<Anthropic.ThinkingConfigParam> {
  const info = await client.models.retrieve(model);
  if (info.lifecycle === 'retired') throw new AgentError(`Model ${model} is retired; choose another model.`);
  if (info.lifecycle === 'deprecated') log?.(`warning: ${model} is deprecated${info.retires_at ? ` and retires ${info.retires_at}` : ''}`);
  if (info.capabilities?.thinking.types.between_tools.supported) return { type: 'between_tools' };
  log?.(`${model} has no between_tools thinking; quick mode keeps adaptive thinking`);
  return { type: 'adaptive' };
}

/**
 * A minimal manual tool-use loop: call Claude, run any requested tools, send
 * every result back in ONE user message, repeat until Claude stops asking.
 */
export async function runAgent(client: Anthropic, question: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const { model = 'claude-opus-5-5', maxTurns = 5, tools = defaultTools, stream = false, onText, log, quick = false, onStatus } = opts;
  const thinking: Anthropic.ThinkingConfigParam = quick ? await quickThinking(client, model, log) : { type: 'adaptive' };
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const toolCalls: AgentResult['toolCalls'] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 4096,
      thinking,
      ...(quick && { speed: 'fast' as const }),
      system: 'You are a helpful shopping assistant. Use tools when needed.',
      tools: Object.values(tools).map((t) => t.definition),
      messages,
    };
    let message: Anthropic.Message;
    if (stream) {
      const s = client.messages.stream(params);
      if (onText) s.on('text', onText);
      message = await s.finalMessage();
    } else {
      message = await client.messages.create(params);
    }

    // Reasoning is useful for debugging, but it isn't the answer: log it, never show it. With between_tools there is no
    // reasoning, only progress updates written for the user, so those go to the status line.
    for (const block of message.content) {
      if (block.type !== 'thinking' || !block.thinking) continue;
      if (thinking.type === 'between_tools') onStatus?.(block.thinking);
      else log?.(`thinking: ${block.thinking}`);
    }

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
