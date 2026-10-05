// mock-llm playground: docs + live tutorial.
//   npm run playground   →   http://localhost:4317
//
// Every "Run" creates a fresh mock-llm, loads the scenario, and calls it with the
// *official* provider SDK, exactly as an app under test would. Progress (stream
// deltas, tool calls, errors), the journal and the raw wire traffic are streamed
// back to the browser.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import YAML from 'yaml';
import { assertions as matchers, createMockLLM } from '../dist/index.js';
import { buildMeta, DEFAULT_MODELS, DOCS } from './meta.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(here, 'public');
const PORT = Number(process.env.PORT ?? 4317);

const WEATHER = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    reviewer: { type: 'string', format: 'email' },
  },
  required: ['title', 'rating', 'tags', 'reviewer'],
  additionalProperties: false,
};


/** The demo "app's" tool implementation. Bad arguments are reported back like a careful app would. */
function runTool(call) {
  let args = call.input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return { ok: false, output: { error: `Invalid JSON arguments: ${args}` } };
    }
  }
  if (call.name !== WEATHER.name) return { ok: false, output: { error: `Unknown tool: ${call.name}` } };
  if (typeof args?.city !== 'string') return { ok: false, output: { error: `'city' must be a string, got ${JSON.stringify(args?.city)}` } };
  return { ok: true, output: { city: args.city, tempC: 21, conditions: 'sunny' } };
}

// --------------------------------------------------------------------------
// Provider drivers: build a request, run one turn, append tool results.

const drivers = {
  openai: {
    client: (mock, o) =>
      new OpenAI({ baseURL: mock.urls.openai, apiKey: 'demo', maxRetries: o.maxRetries, timeout: o.timeoutMs, defaultHeaders: o.headers }),
    init: (o) => ({ messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), { role: 'user', content: o.prompt }] }),
    async turn(c, st, o, onDelta) {
      const params = {
        model: o.model,
        messages: st.messages,
        ...(o.tools && { tools: [{ type: 'function', function: { name: WEATHER.name, description: WEATHER.description, parameters: WEATHER.schema } }] }),
        ...(o.structured && { response_format: { type: 'json_schema', json_schema: { name: 'review', schema: REVIEW_SCHEMA } } }),
      };
      let raw;
      if (o.stream) {
        const s = c.chat.completions.stream(params);
        s.on('content', (d) => onDelta(d));
        s.on('refusal.delta', (e) => onDelta(e.delta));
        raw = await s.finalChatCompletion();
      } else raw = await c.chat.completions.create(params);
      const msg = raw.choices[0].message;
      st.messages.push(msg);
      return {
        raw,
        text: msg.content || msg.refusal || '',  // streamed messages start with content: ''
        stop: raw.choices[0].finish_reason,
        toolCalls: (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, input: t.function.arguments })),
      };
    },
    addResults(st, calls, results) {
      calls.forEach((c, i) => st.messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(results[i].output) }));
    },
  },

  'openai-responses': {
    client: (mock, o) => drivers.openai.client(mock, o),
    init: (o) => ({ input: o.prompt, previous: undefined }),
    async turn(c, st, o, onDelta) {
      const params = {
        model: o.model,
        input: st.input,
        ...(o.system && { instructions: o.system }),
        ...(st.previous && { previous_response_id: st.previous }),
        ...(o.tools && { tools: [{ type: 'function', name: WEATHER.name, description: WEATHER.description, parameters: WEATHER.schema, strict: true }] }),
        ...(o.structured && { text: { format: { type: 'json_schema', name: 'review', schema: REVIEW_SCHEMA } } }),
      };
      let raw;
      if (o.stream) {
        const s = c.responses.stream(params);
        s.on('response.output_text.delta', (e) => onDelta(e.delta));
        s.on('response.refusal.delta', (e) => onDelta(e.delta));
        raw = await s.finalResponse();
      } else raw = await c.responses.create(params);
      st.previous = raw.id;
      const refusal = raw.output.flatMap((o) => (o.type === 'message' ? o.content : [])).find((p) => p.type === 'refusal');
      return {
        raw,
        text: raw.output_text || refusal?.refusal || '',
        stop: raw.status + (raw.incomplete_details ? ` (${raw.incomplete_details.reason})` : ''),
        toolCalls: raw.output.filter((x) => x.type === 'function_call').map((x) => ({ id: x.call_id, name: x.name, input: x.arguments })),
      };
    },
    addResults(st, calls, results) {
      st.input = calls.map((c, i) => ({ type: 'function_call_output', call_id: c.id, output: JSON.stringify(results[i].output) }));
    },
  },

  anthropic: {
    client: (mock, o) =>
      new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'demo', maxRetries: o.maxRetries, timeout: o.timeoutMs, defaultHeaders: o.headers }),
    init: (o) => ({ messages: [{ role: 'user', content: o.prompt }] }),
    async turn(c, st, o, onDelta) {
      const params = {
        model: o.model,
        max_tokens: 1024,
        messages: st.messages,
        ...(o.system && { system: o.system }),
        ...(o.tools && { tools: [{ name: WEATHER.name, description: WEATHER.description, input_schema: WEATHER.schema }] }),
        ...(o.structured && { output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } } }),
      };
      let raw;
      if (o.stream) {
        const s = c.messages.stream(params);
        s.on('text', (d) => onDelta(d));
        raw = await s.finalMessage();
      } else raw = await c.messages.create(params);
      st.messages.push({ role: 'assistant', content: raw.content });
      return {
        raw,
        text: raw.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        stop: raw.stop_reason,
        toolCalls: raw.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
      };
    },
    addResults(st, calls, results) {
      st.messages.push({
        role: 'user',
        content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(results[i].output), is_error: !results[i].ok })),
      });
    },
  },

  gemini: {
    client: (mock, o) =>
      new GoogleGenAI({
        apiKey: 'demo',
        httpOptions: {
          baseUrl: mock.urls.gemini,
          timeout: o.timeoutMs,
          headers: o.headers,
          // @google/genai only retries when retryOptions is set.
          ...(o.maxRetries > 0 && { retryOptions: { attempts: o.maxRetries + 1, initialDelay: 0.2 } }),
        },
      }),
    init: (o) => ({ contents: [{ role: 'user', parts: [{ text: o.prompt }] }] }),
    async turn(c, st, o, onDelta) {
      const params = {
        model: o.model,
        contents: st.contents,
        config: {
          ...(o.system && { systemInstruction: o.system }),
          ...(o.tools && { tools: [{ functionDeclarations: [{ name: WEATHER.name, description: WEATHER.description, parametersJsonSchema: WEATHER.schema }] }] }),
          ...(o.structured && { responseMimeType: 'application/json', responseJsonSchema: REVIEW_SCHEMA }),
        },
      };
      let raw;
      let text = '';
      let calls = [];
      if (o.stream) {
        const chunks = [];
        for await (const chunk of await c.models.generateContentStream(params)) {
          chunks.push(chunk);
          const piece = textOf(chunk);
          if (piece) {
            text += piece;
            onDelta(piece);
          }
          calls.push(...(chunk.functionCalls ?? []));
        }
        raw = { note: `${chunks.length} streamed chunks; last chunk shown`, lastChunk: chunks.at(-1) };
      } else {
        raw = await c.models.generateContent(params);
        text = textOf(raw);
        calls = raw.functionCalls ?? [];
      }
      const last = o.stream ? raw.lastChunk : raw;
      st.contents.push({ role: 'model', parts: [...(text ? [{ text }] : []), ...calls.map((fc) => ({ functionCall: fc }))] });
      return { raw, text, stop: last?.candidates?.[0]?.finishReason, toolCalls: calls.map((fc) => ({ id: fc.id ?? fc.name, name: fc.name, input: fc.args })) };
    },
    addResults(st, calls, results) {
      st.contents.push({ role: 'user', parts: calls.map((c, i) => ({ functionResponse: { name: c.name, response: results[i].output } })) });
    },
  },

  bedrock: {
    client(mock, o) {
      const client = new BedrockRuntimeClient({
        endpoint: mock.urls.bedrock,
        region: 'us-east-1',
        credentials: { accessKeyId: 'demo', secretAccessKey: 'demo' },
        maxAttempts: o.maxRetries + 1,
        ...(o.timeoutMs && { requestHandler: { requestTimeout: o.timeoutMs } }),
      });
      if (o.headers) {
        client.middlewareStack.add((next) => (args) => {
          Object.assign(args.request.headers, o.headers);
          return next(args);
        }, { step: 'build' });
      }
      return client;
    },
    init: (o) => ({ messages: [{ role: 'user', content: [{ text: o.prompt }] }] }),
    async turn(c, st, o, onDelta) {
      const params = {
        modelId: o.model,
        messages: st.messages,
        ...(o.system && { system: [{ text: o.system }] }),
        ...(o.tools && { toolConfig: { tools: [{ toolSpec: { name: WEATHER.name, description: WEATHER.description, inputSchema: { json: WEATHER.schema } } }] } }),
      };
      let content;
      let stop;
      let raw;
      if (o.stream) {
        const r = await c.send(new ConverseStreamCommand(params));
        const blocks = [];
        const events = [];
        for await (const ev of r.stream) {
          events.push(Object.keys(ev)[0]);
          const i = ev.contentBlockStart?.contentBlockIndex ?? ev.contentBlockDelta?.contentBlockIndex;
          if (ev.contentBlockStart?.start?.toolUse) blocks[i] = { toolUse: { ...ev.contentBlockStart.start.toolUse, input: '' } };
          const d = ev.contentBlockDelta?.delta;
          if (d?.text !== undefined) {
            blocks[i] ??= { text: '' };
            blocks[i].text += d.text;
            onDelta(d.text);
          }
          if (d?.toolUse) blocks[i].toolUse.input += d.toolUse.input;
          if (ev.messageStop) stop = ev.messageStop.stopReason;
        }
        content = blocks.filter(Boolean).map((b) => {
          if (!b.toolUse) return b;
          let input = b.toolUse.input;
          try {
            input = JSON.parse(input);
          } catch {}
          return { toolUse: { ...b.toolUse, input } };
        });
        raw = { events, assembled: content };
      } else {
        raw = await c.send(new ConverseCommand(params));
        content = raw.output.message.content;
        stop = raw.stopReason;
        delete raw.$metadata;
      }
      st.messages.push({ role: 'assistant', content });
      return {
        raw,
        text: content.filter((b) => b.text !== undefined).map((b) => b.text).join(''),
        stop,
        toolCalls: content.filter((b) => b.toolUse).map((b) => ({ id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input })),
      };
    },
    addResults(st, calls, results) {
      st.messages.push({
        role: 'user',
        content: calls.map((c, i) => ({
          toolResult: { toolUseId: c.id, content: [{ json: results[i].output }], status: results[i].ok ? 'success' : 'error' },
        })),
      });
    },
  },
};

// --------------------------------------------------------------------------

/** Gemini answer text without the SDK's `.text` getter (which warns when function calls are present). */
function textOf(response) {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}

/**
 * Run lesson assertions with the real matcher core (the same code as mock-llm/vitest).
 * Each: { matcher, args?, not? }; `{ regex, flags }` args become RegExps.
 */
function evaluateAssertions(mock, list) {
  const revive = (v) => (v && typeof v === 'object' && 'regex' in v ? new RegExp(v.regex, v.flags) : v);
  return list.map(({ matcher, args = [], not = false }) => {
    const fn = matchers[matcher];
    const label = `expect(mock)${not ? '.not' : ''}.${matcher}(${args.map((a) => (a && typeof a === 'object' && 'regex' in a ? `/${a.regex}/${a.flags ?? ''}` : JSON.stringify(a))).join(', ')})`;
    if (!fn) return { label, pass: false, message: `Unknown matcher ${matcher}` };
    const r = fn(mock, ...args.map(revive));
    return { label, pass: not ? !r.pass : r.pass, message: r.message() };
  });
}

function describeError(e) {
  return {
    name: e?.constructor?.name && e.constructor.name !== 'Error' ? e.constructor.name : (e?.name ?? 'Error'),
    status: e?.status ?? e?.$metadata?.httpStatusCode,
    message: String(e?.message ?? e).slice(0, 600),
  };
}

function parseRules(rules) {
  if (!rules) return {};
  if (typeof rules === 'object') return rules;
  const text = String(rules).trim();
  if (!text) return {};
  return text.startsWith('{') ? JSON.parse(text) : (YAML.parse(text) ?? {});
}

async function run(body, send) {
  const provider = drivers[body.provider] ? body.provider : 'openai';
  const driver = drivers[provider];
  const o = {
    prompt: body.prompt ?? 'Hello!',
    system: body.system || undefined,
    model: body.model || DEFAULT_MODELS[provider],
    stream: !!body.stream,
    tools: !!body.tools,
    structured: !!body.structured,
    maxRetries: Number(body.maxRetries ?? 0),
    timeoutMs: body.timeoutMs ? Number(body.timeoutMs) : undefined,
    headers: body.scenarioHeader ? { 'x-mock-scenario': body.scenarioHeader } : undefined,
  };

  let rules;
  try {
    rules = parseRules(body.rules);
  } catch (e) {
    return send('error', { name: 'ScenarioParseError', message: e.message });
  }

  const mock = await createMockLLM({ seed: Number(body.seed ?? 1), latency: body.latency, strict: !!body.strict, contextWindow: body.contextWindow, chaos: body.chaos });
  const started = Date.now();
  // Mirror mock events to the browser (Events tab) via the public mock.on() API.
  let chunkEvents = 0;
  const inFlight = new Set();
  mock.on('request', (p) => inFlight.add(p.entry.id));
  mock.on('response', (p) => inFlight.delete(p.entry.id));
  mock.on('fault', (p) => inFlight.delete(p.entry.id));
  for (const name of ['request', 'unmatched', 'chunk', 'response', 'fault']) {
    mock.on(name, (p) => {
      if (name === 'chunk' && ++chunkEvents > 300) return; // keep huge streams readable
      send('mockevent', {
        name,
        id: p.entry.id,
        t: Date.now() - started,
        status: p.entry.status,
        endpoint: p.entry.endpoint,
        ...(name === 'chunk' && { index: p.index, binary: typeof p.data !== 'string', text: p.text.slice(0, 160) }),
        ...(name === 'fault' && { fault: p.fault.type }),
        ...(name === 'request' && { matchedBy: p.entry.matchedBy ?? null }),
      });
    });
  }
  try {
    try {
      await mock.load(rules);
    } catch (e) {
      return send('error', { name: 'ScenarioError', message: e.message });
    }
    send('start', { provider, model: o.model, baseUrl: mock.urls[provider === 'openai-responses' ? 'openai' : provider] });

    const client = driver.client(mock, o);
    const st = driver.init(o);
    const maxTurns = body.agentLoop ? 4 : 1;
    for (let turn = 1; turn <= maxTurns; turn++) {
      send('turn-start', { turn });
      let result;
      try {
        result = await driver.turn(client, st, o, (text) => send('delta', { turn, text }));
      } catch (e) {
        send('error', { turn, ...describeError(e) });
        break;
      }
      send('turn', { turn, text: result.text, stop: result.stop, toolCalls: result.toolCalls, raw: result.raw });
      if (!body.agentLoop || !result.toolCalls.length) break;
      const results = result.toolCalls.map(runTool);
      send('tools', { turn, calls: result.toolCalls, results });
      driver.addResults(st, result.toolCalls, results);
    }
  } finally {
    // A client-side timeout throws before the mock sees the socket close; let exchanges finish
    // (their terminal fault/response event) before reporting.
    for (const until = Date.now() + 2000; inFlight.size && Date.now() < until; ) await new Promise((r) => setTimeout(r, 10));
    if (Array.isArray(body.assertions) && body.assertions.length) send('assertions', { results: evaluateAssertions(mock, body.assertions) });
    const journal = mock.journal.all().map((e) => ({
      id: e.id,
      provider: e.provider,
      endpoint: e.endpoint,
      method: e.method,
      path: e.path,
      status: e.status,
      matchedBy: e.matchedBy,
      chaos: e.chaos,
      durationMs: e.durationMs,
      usage: e.usage,
      fault: e.fault,
      request: { ...e.request, raw: undefined, headers: undefined },
      response: e.response,
      wire: e.wire,
    }));
    send('journal', { entries: journal, cost: mock.journal.cost(), usage: mock.journal.usage(), elapsedMs: Date.now() - started });
    await mock.stop();
  }
}

// --------------------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await run(body, send);
      send('done', {});
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(buildMeta()));
    }
    if (req.method === 'GET' && new RegExp(`^/docs/(${DOCS.join('|')})\\.md$`).test(url.pathname)) {
      // The repo's own docs, served as plain text so Reference links resolve.
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(await readFile(join(here, '..', url.pathname.slice('/docs/'.length))));
    }
    const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) throw Object.assign(new Error('forbidden'), { code: 'ENOENT' });
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(e.code === 'ENOENT' ? 'Not found' : String(e.stack ?? e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  mock-llm playground → http://localhost:${server.address().port}\n`);
});
