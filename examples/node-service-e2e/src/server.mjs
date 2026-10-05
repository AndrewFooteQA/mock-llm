// A tiny HTTP service with an LLM behind it. It is configured entirely by
// environment variables, the way it would be in production:
//   LLM_PROVIDER=openai|anthropic, OPENAI_BASE_URL / ANTHROPIC_BASE_URL, API keys, PORT.
//   LLM_FORWARD_HEADERS: comma-separated request headers passed through to the LLM call (e.g. x-request-id for tracing).
//   LLM_TIMEOUT_MS: give up on the LLM after this long (default 30 s; the SDKs' own default is 10 minutes).
import { createServer } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const SYSTEM = 'You are the Acme Store assistant. Answer in one short paragraph.';
const provider = process.env.LLM_PROVIDER ?? 'openai';
const timeout = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const forwarded = (process.env.LLM_FORWARD_HEADERS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const forwardHeaders = (req) => Object.fromEntries(forwarded.filter((h) => req.headers[h]).map((h) => [h, String(req.headers[h])]));

const ask =
  provider === 'anthropic'
    ? async (question, headers) => {
        const client = new Anthropic({ maxRetries: 1, timeout });
        const m = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 512, system: SYSTEM, messages: [{ role: 'user', content: question }] }, { headers });
        return m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      }
    : async (question, headers) => {
        const client = new OpenAI({ maxRetries: 1, timeout });
        const r = await client.chat.completions.create(
          { model: 'gpt-4o', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }] },
          { headers },
        );
        return r.choices[0].message.content ?? '';
      };

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { message } = JSON.parse(body);
    const reply = await ask(String(message ?? ''), forwardHeaders(req));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ reply }));
  } catch (err) {
    console.error(`[${provider}] upstream error:`, err?.status ?? '', err?.message);
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'assistant_unavailable' }));
  }
});

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  console.log(`listening on ${server.address().port}`);
});
