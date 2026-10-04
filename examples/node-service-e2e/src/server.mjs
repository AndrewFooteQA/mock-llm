// A tiny HTTP service with an LLM behind it. It is configured entirely by
// environment variables, the way it would be in production:
//   LLM_PROVIDER=openai|anthropic, OPENAI_BASE_URL / ANTHROPIC_BASE_URL, API keys, PORT.
import { createServer } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const SYSTEM = 'You are the Acme Store assistant. Answer in one short paragraph.';
const provider = process.env.LLM_PROVIDER ?? 'openai';

const ask =
  provider === 'anthropic'
    ? async (question) => {
        const client = new Anthropic({ maxRetries: 1 });
        const m = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 512, system: SYSTEM, messages: [{ role: 'user', content: question }] });
        return m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      }
    : async (question) => {
        const client = new OpenAI({ maxRetries: 1 });
        const r = await client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }],
        });
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
    const reply = await ask(String(message ?? ''));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ reply }));
  } catch (err) {
    console.error(`[${provider}] upstream error:`, err?.status ?? '', err?.message);
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'assistant_unavailable' }));
  }
});

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  console.log(`listening on ${server.address().port}`);
});
