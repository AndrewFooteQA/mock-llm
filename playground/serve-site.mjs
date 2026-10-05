// Serve site/ (the static GitHub Pages build) under a subpath, the way Pages does: /mock-llm/…
//   node playground/serve-site.mjs [port]   (BASE env overrides the subpath)
// Anything under api/ is a 404, so the static frontend can't quietly depend on the live server.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const BASE = process.env.BASE ?? '/mock-llm/';
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4318);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(BASE)) {
    res.writeHead(404).end(`Not under ${BASE}`);
    return;
  }
  const rel = path.slice(BASE.length) || 'index.html';
  const file = normalize(join(SITE, rel));
  if (!file.startsWith(SITE) || rel.startsWith('api/')) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`site/ → http://127.0.0.1:${PORT}${BASE}`));
