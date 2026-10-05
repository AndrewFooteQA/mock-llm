// How the page talks to the playground: live (the local server's /api/meta and /api/run SSE) or static (the GitHub
// Pages build: meta.json plus recorded runs replayed with their original timing). The static build marks index.html
// with <html data-mode="static">; nothing else in the app differs between the two.
import { runKey } from './runs.js';

export const isStatic = document.documentElement.dataset.mode === 'static';

/** Longest replay of one recorded run: long recordings (latency lessons) are sped up to fit. */
const MAX_REPLAY_MS = 3000;

export class NoRecordingError extends Error {
  name = 'NoRecordingError';
}

let metaPromise;
/** Fault / edge / scenario names and models, from the library itself. */
export const getMeta = () => (metaPromise ??= fetch(isStatic ? 'meta.json' : 'api/meta').then((r) => r.json()));

/**
 * Run `payload`, calling `onEvent(name, data)` for each event in order. Resolves when the run ends. Static mode
 * rejects with NoRecordingError when the payload was edited into something that wasn't recorded.
 */
export async function run(payload, onEvent) {
  return isStatic ? replay(payload, onEvent) : live(payload, onEvent);
}

async function live(payload, onEvent) {
  const res = await fetch('api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev) onEvent(ev, data ? JSON.parse(data) : {});
    }
  }
}

async function replay(payload, onEvent) {
  const res = await fetch(`recordings/${await runKey(payload)}.json`);
  if (!res.ok) throw new NoRecordingError('This exact run isn’t recorded on the hosted site. Use “Run it live” or run the playground locally.');
  const recording = await res.json();
  const last = recording.events.at(-1)?.[0] ?? 0;
  const scale = last > MAX_REPLAY_MS ? MAX_REPLAY_MS / last : 1;
  onEvent('recorded', { version: recording.version, recordedAt: recording.recordedAt });
  const start = performance.now();
  for (const [at, ev, data] of recording.events) {
    const wait = at * scale - (performance.now() - start);
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    onEvent(ev, data);
  }
}
