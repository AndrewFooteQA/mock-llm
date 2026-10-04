import { chunkText, textPieces } from '../core/tokens.js';

/** Output parts → the text block they came from (for exact stream chunks; never serialized). */
const PART_SOURCE = new WeakMap<object, { text: string; chunks?: string[] }>();
import type { IRMessage, IRRequest, IRRequestPart, IRResponse, IRTool } from '../core/types.js';
import { ApiError, defaultStopReason, pieces, requireField, sse, toolInputString, type RenderContext } from './adapter.js';

/** OpenAI Responses API (`POST /v1/responses`). Shares errors/auth with Chat Completions. */

const stateKey = (id: string) => `openai.responses:${id}`;

export function parseResponsesBody(body: any, base: IRRequest, state: Map<string, unknown>): IRRequest {
  requireField(body.input !== undefined || typeof body.previous_response_id === 'string', "Missing required parameter: 'input'.");

  const system: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions);

  let messages: IRMessage[] = [];
  if (body.previous_response_id) {
    const prev = state.get(stateKey(body.previous_response_id)) as IRMessage[] | undefined;
    if (!prev) throw new ApiError({ kind: 'bad_request', message: `Previous response with id '${body.previous_response_id}' not found.` });
    messages = [...prev];
  }

  const items: any[] = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? []);
  for (const item of items) {
    const type = item?.type ?? 'message';
    if (type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        system.push(textOf(item.content));
      } else {
        messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: partsOf(item.content) });
      }
    } else if (type === 'function_call') {
      const part: IRRequestPart = { type: 'tool_call', id: item.call_id, name: item.name, input: tryJson(item.arguments) };
      const last = messages.at(-1);
      if (last?.role === 'assistant') last.content = [...last.content, part];
      else messages.push({ role: 'assistant', content: [part] });
    } else if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) }],
      });
    }
    // reasoning and other item types carry nothing the IR models
  }

  const tools: IRTool[] = (body.tools ?? [])
    .filter((t: any) => t?.type === 'function')
    .map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));

  const fmt = body.text?.format;
  return {
    ...base,
    system: system.length ? system.join('\n\n') : undefined,
    messages,
    tools,
    toolChoice: body.tool_choice,
    responseFormat: fmt?.type && fmt.type !== 'text' ? { type: fmt.type, schema: fmt.schema } : undefined,
    stream: body.stream === true,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
  };
}

interface Built {
  response: Record<string, unknown>;
  output: Array<Record<string, any>>;
}

function build(req: IRRequest, res: IRResponse, ctx: RenderContext): Built {
  const id = `resp_${ctx.rng.id(40)}`;
  const stop = defaultStopReason(res);
  const output: Array<Record<string, any>> = [];
  let message: Record<string, any> | undefined;

  for (const c of res.content) {
    if (c.type === 'thinking') {
      output.push({ id: `rs_${ctx.rng.id(40)}`, type: 'reasoning', summary: [{ type: 'summary_text', text: c.text }] });
      message = undefined;
    } else if (c.type === 'text') {
      if (!message) {
        message = { id: `msg_${ctx.rng.id(40)}`, type: 'message', status: 'completed', role: 'assistant', content: [] };
        output.push(message);
      }
      const part = stop === 'refusal' ? { type: 'refusal', refusal: c.text } : { type: 'output_text', text: c.text, annotations: [], logprobs: [] };
      PART_SOURCE.set(part, c);
      message.content.push(part);
    } else {
      output.push({
        id: `fc_${ctx.rng.id(40)}`,
        type: 'function_call',
        status: 'completed',
        call_id: c.id ?? `call_${ctx.rng.id(24)}`,
        name: c.name,
        arguments: toolInputString(c.input),
      });
      message = undefined;
    }
  }

  const incomplete = stop === 'max_tokens' ? 'max_output_tokens' : stop === 'content_filter' ? 'content_filter' : null;
  const { inputTokens, outputTokens, cacheReadInputTokens = 0 } = ctx.usage;
  const raw = req.raw ?? {};
  const response = {
    id,
    object: 'response',
    created_at: ctx.created,
    status: incomplete ? 'incomplete' : 'completed',
    background: false,
    error: null,
    incomplete_details: incomplete ? { reason: incomplete } : null,
    instructions: raw.instructions ?? null,
    max_output_tokens: raw.max_output_tokens ?? null,
    model: res.model ?? req.model,
    output,
    parallel_tool_calls: raw.parallel_tool_calls ?? true,
    previous_response_id: raw.previous_response_id ?? null,
    reasoning: { effort: raw.reasoning?.effort ?? null, summary: null },
    store: raw.store ?? true,
    temperature: raw.temperature ?? 1,
    text: raw.text ?? { format: { type: 'text' } },
    tool_choice: raw.tool_choice ?? 'auto',
    tools: raw.tools ?? [],
    top_p: raw.top_p ?? 1,
    truncation: 'disabled',
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: cacheReadInputTokens },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    user: null,
    metadata: raw.metadata ?? {},
  };

  if (raw.store !== false) {
    // Remember the conversation so `previous_response_id` works on the next turn.
    const assistant: IRRequestPart[] = [];
    for (const item of output) {
      if (item.type === 'message') {
        for (const p of item.content) assistant.push({ type: 'text', text: p.text ?? p.refusal ?? '' });
      } else if (item.type === 'function_call') {
        assistant.push({ type: 'tool_call', id: item.call_id, name: item.name, input: tryJson(item.arguments) });
      }
    }
    ctx.state.set(stateKey(id), [...req.messages, { role: 'assistant', content: assistant }]);
  }
  return { response, output };
}

export function renderResponses(req: IRRequest, res: IRResponse, ctx: RenderContext): Record<string, unknown> {
  return build(req, res, ctx).response;
}

export function streamResponses(req: IRRequest, res: IRResponse, ctx: RenderContext): string[] {
  const { response, output } = build(req, res, ctx);
  const chunks: string[] = [];
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>) => chunks.push(sse({ type, sequence_number: seq++, ...data }, type));
  const pending = { ...response, status: 'in_progress', output: [], usage: null, incomplete_details: null };

  ev('response.created', { response: pending });
  ev('response.in_progress', { response: pending });
  output.forEach((item, output_index) => {
    const item_id = item.id;
    if (item.type === 'reasoning') {
      const text = item.summary[0].text as string;
      ev('response.output_item.added', { output_index, item: { ...item, summary: [] } });
      ev('response.reasoning_summary_part.added', { item_id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      for (const delta of chunkText(text)) ev('response.reasoning_summary_text.delta', { item_id, output_index, summary_index: 0, delta });
      ev('response.reasoning_summary_text.done', { item_id, output_index, summary_index: 0, text });
      ev('response.reasoning_summary_part.done', { item_id, output_index, summary_index: 0, part: { type: 'summary_text', text } });
    } else if (item.type === 'message') {
      ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } });
      item.content.forEach((part: any, content_index: number) => {
        const isRefusal = part.type === 'refusal';
        const full: string = isRefusal ? part.refusal : part.text;
        const empty = isRefusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [], logprobs: [] };
        ev('response.content_part.added', { item_id, output_index, content_index, part: empty });
        for (const delta of PART_SOURCE.has(part) ? textPieces(PART_SOURCE.get(part)!) : chunkText(full)) {
          ev(isRefusal ? 'response.refusal.delta' : 'response.output_text.delta', { item_id, output_index, content_index, delta, ...(isRefusal ? {} : { logprobs: [] }) });
        }
        ev(isRefusal ? 'response.refusal.done' : 'response.output_text.done', {
          item_id,
          output_index,
          content_index,
          ...(isRefusal ? { refusal: full } : { text: full, logprobs: [] }),
        });
        ev('response.content_part.done', { item_id, output_index, content_index, part });
      });
    } else {
      ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', arguments: '' } });
      for (const delta of pieces(item.arguments)) ev('response.function_call_arguments.delta', { item_id, output_index, delta });
      ev('response.function_call_arguments.done', { item_id, output_index, arguments: item.arguments });
    }
    ev('response.output_item.done', { output_index, item });
  });
  ev(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
  return chunks;
}

/** In-stream error event for the Responses API; `sequence` continues the stream's numbering (one event per chunk). */
export function responsesStreamError(error: { message: string; type: string; code: string | null; param: string | null }, sequence = 0): string {
  return sse({ type: 'error', sequence_number: sequence, code: error.code ?? error.type, message: error.message, param: error.param }, 'error');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => p?.text ?? '').join('');
  return '';
}

function partsOf(content: unknown): IRRequestPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((p: any): IRRequestPart =>
    p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text' ? { type: 'text', text: p.text ?? '' } : { type: 'image' },
  );
}

function tryJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
