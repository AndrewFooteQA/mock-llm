// A tiny chat app. The LLM is called from the *server* (OpenAI SDK configured by env vars),
// as in most real apps. Nothing here knows about mock-llm.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';

const SYSTEM = 'You are the Acme Store assistant. Use lookup_order for order questions.';
const TOOLS = [{ type: 'function', function: { name: 'lookup_order', parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } } }];
const ORDERS = { 'A-1001': { status: 'shipped', eta: 'Oct 8' } };
const client = new OpenAI({ maxRetries: 1 });

async function answer(message) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: message }];
  for (let turn = 0; turn < 4; turn++) {
    const msg = (await client.chat.completions.create({ model: 'gpt-4o', messages, tools: TOOLS })).choices[0].message;
    if (!msg.tool_calls?.length) return msg.content ?? '';
    messages.push(msg);
    for (const call of msg.tool_calls) {
      const { order_id } = JSON.parse(call.function.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(ORDERS[order_id] ?? { error: 'not found' }) });
    }
  }
  return 'Sorry, that took too long.';
}

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const readJson = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
};

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(new URL('./public/index.html', import.meta.url)));
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const { message } = await readJson(req);
      return json(res, 200, { reply: await answer(message) });
    }
    if (req.method === 'POST' && req.url === '/api/stream') {
      const { message } = await readJson(req);
      const stream = await client.chat.completions.create({ model: 'gpt-4o', stream: true, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: message }] });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      for await (const chunk of stream) res.write(chunk.choices[0]?.delta?.content ?? '');
      return res.end();
    }
    res.writeHead(404).end();
  } catch (err) {
    console.error('[chat] LLM error:', err.status ?? '', err.message);
    if (!res.headersSent) json(res, 503, { error: 'assistant_unavailable' });
    else res.end();
  }
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
