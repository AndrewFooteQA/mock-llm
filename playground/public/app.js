import { LESSONS, PROVIDERS } from './lessons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sidebar = $('#sidebar');

// ------------------------------------------------------------------ storage (best effort)
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`mock-llm:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`mock-llm:${key}`, JSON.stringify(value));
    } catch {}
  },
};

// ------------------------------------------------------------------ theme
const applyTheme = (t) => (t ? document.documentElement.setAttribute('data-theme', t) : document.documentElement.removeAttribute('data-theme'));
applyTheme(store.get('theme', null));
$('#theme').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
});
$('#menu').addEventListener('click', () => sidebar.classList.toggle('open'));

// ------------------------------------------------------------------ html helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const PATTERNS = {
  ts: /(\/\/.*$|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(const|let|await|async|new|import|from|return|function|if|else|for|of|true|false|null|undefined|export|expect)\b|(\b\d[\d_]*(?:\.\d+)?\b)/gm,
  yaml: /(#.*$)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|((?:^[ \t]*(?:- )?|[{,][ \t]*)[\w$.-]+(?=:))|(\b-?\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/gm,
  json: /(\b_never_\b)|("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/gm,
};

function highlight(code, lang) {
  const re = PATTERNS[lang];
  if (!re) return esc(code);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m; (m = re.exec(code)); ) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    out += esc(code.slice(last, m.index));
    const cls =
      lang === 'json'
        ? m[2] ? 't-k' : m[3] ? 't-s' : 't-n'
        : lang === 'yaml'
          ? m[1] ? 't-c' : m[2] ? 't-s' : m[3] ? 't-k' : 't-n'
          : m[1] ? 't-c' : m[2] ? 't-s' : m[3] ? 't-w' : 't-n';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

function codeBlock(code, lang) {
  const node = h(`<div class="code"><button class="copy" type="button">Copy</button><pre><code>${highlight(code, lang)}</code></pre></div>`);
  $('.copy', node).addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(code);
      e.target.textContent = 'Copied';
    } catch {
      e.target.textContent = 'Copy failed';
    }
    setTimeout(() => (e.target.textContent = 'Copy'), 1200);
  });
  return node;
}

const pretty = (v) => JSON.stringify(v, null, 2);
function prettyMaybeJson(text) {
  try {
    return { text: pretty(JSON.parse(text)), lang: 'json' };
  } catch {
    return { text, lang: 'text' };
  }
}

// ------------------------------------------------------------------ meta (from the library itself)
let metaPromise;
const meta = () => (metaPromise ??= fetch('/api/meta').then((r) => r.json()));

// ------------------------------------------------------------------ router
const done = new Set(store.get('done', []));

function renderSidebar(activeId) {
  const groups = [];
  for (const l of LESSONS) {
    let g = groups.find((x) => x.name === l.group);
    if (!g) groups.push((g = { name: l.group, items: [] }));
    g.items.push(l);
  }
  let n = 0;
  sidebar.innerHTML = groups
    .map(
      (g) =>
        `<h4>${esc(g.name)}</h4>` +
        g.items
          .map((l) => {
            n++;
            const cls = [l.id === activeId ? 'active' : '', done.has(l.id) ? 'done' : ''].join(' ');
            return `<a href="#/lesson/${l.id}" class="${cls}"><span class="num">${done.has(l.id) ? '✓' : n}</span>${esc(l.title)}</a>`;
          })
          .join(''),
    )
    .join('');
}

function route() {
  const hash = location.hash || '#/lesson/first-mock';
  const [, section, id] = hash.split('/');
  document.querySelectorAll('.mainnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  sidebar.classList.remove('open');
  if (section === 'playground') {
    renderSidebar(null);
    renderPlayground();
  } else if (section === 'reference') {
    renderSidebar(null);
    renderReference();
  } else {
    const lesson = LESSONS.find((l) => l.id === id) ?? LESSONS[0];
    renderSidebar(lesson.id);
    renderLesson(lesson);
  }
  window.scrollTo(0, 0);
  view.focus({ preventScroll: true });
}
addEventListener('hashchange', route);

// ------------------------------------------------------------------ lesson view
function renderLesson(lesson) {
  const idx = LESSONS.indexOf(lesson);
  const prev = LESSONS[idx - 1];
  const next = LESSONS[idx + 1];
  document.title = `${lesson.title} · mock-llm`;

  const page = h(`<article class="lesson ${lesson.static ? 'static' : ''}">
    <div class="left">
      <p class="eyebrow">${esc(lesson.group)} · ${idx + 1} of ${LESSONS.length}</p>
      <h1>${esc(lesson.title)}</h1>
      <div class="prose">${lesson.intro}</div>
      ${lesson.tip ? `<div class="tip"><span aria-hidden="true">💡</span><div>${lesson.tip}</div></div>` : ''}
      <div class="section-label">In your tests</div>
      <div data-slot="test"></div>
      ${lesson.showScenarioList ? `<div class="section-label">Built-in scenarios</div><div class="ref"><div class="tags" data-slot="scenarios"></div></div>` : ''}
      <nav class="lesson-nav">
        ${prev ? `<a href="#/lesson/${prev.id}"><small>← Previous</small>${esc(prev.title)}</a>` : ''}
        ${next ? `<a class="next" href="#/lesson/${next.id}"><small>Next →</small>${esc(next.title)}</a>` : `<a class="next" href="#/playground"><small>Next →</small>Open the playground</a>`}
      </nav>
    </div>
    ${lesson.static ? '' : `<div class="right" data-slot="run"></div>`}
  </article>`);
  $('[data-slot=test]', page).append(codeBlock(lesson.test, 'ts'));
  if (lesson.showScenarioList) meta().then((m) => ($('[data-slot=scenarios]', page).innerHTML = m.scenarios.map((s) => `<code>${esc(s)}</code>`).join('')));
  view.replaceChildren(page);
  if (!lesson.static) mountLessonRunner($('[data-slot=run]', page), lesson);
}

function mountLessonRunner(slot, lesson) {
  const allowed = lesson.providers ?? PROVIDERS.map((p) => p.id);
  let provider = lesson.defaultProvider ?? store.get('provider', 'openai');
  if (!allowed.includes(provider)) provider = allowed[0];
  let variant = 0;
  const variants = lesson.variants ?? [];

  const panel = h(`<section class="runpanel" aria-label="Live run">
    <div class="controls">
      <div class="row"><span class="label">Provider</span><div class="seg" role="group" aria-label="Provider" data-slot="providers"></div></div>
      ${variants.length ? `<div class="row"><span class="label">Try</span><div class="chips" data-slot="variants"></div></div>` : ''}
      <div>
        <div class="section-label" style="margin-top:0"><span>Scenario file${lesson.editable ? ' (editable)' : ''}</span><span data-slot="yamlnote"></span></div>
        <div data-slot="yaml"></div>
      </div>
      <div class="runbar">
        <div class="request-summary" data-slot="summary"></div>
        <button class="btn primary" type="button" data-slot="go">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>Run
        </button>
      </div>
    </div>
    <div class="results" data-slot="results"></div>
  </section>`);
  slot.replaceChildren(panel);

  let editor;
  const yamlFor = () => (variants[variant]?.yaml ?? lesson.yaml ?? '');
  const runFor = () => ({ ...lesson.run, ...(variants[variant]?.run ?? {}) });

  const drawProviders = () => {
    $('[data-slot=providers]', panel).innerHTML = PROVIDERS.filter((p) => allowed.includes(p.id))
      .map((p) => `<button type="button" data-p="${p.id}" aria-pressed="${p.id === provider}">${esc(p.label)}</button>`)
      .join('');
  };
  const drawVariants = () => {
    const box = $('[data-slot=variants]', panel);
    if (box) box.innerHTML = variants.map((v, i) => `<button type="button" data-v="${i}" aria-pressed="${i === variant}">${esc(v.label)}</button>`).join('');
  };
  const drawYaml = () => {
    const box = $('[data-slot=yaml]', panel);
    const y = yamlFor();
    if (lesson.editable) {
      editor = h(`<textarea class="editor" spellcheck="false" aria-label="Scenario YAML"></textarea>`);
      editor.value = y;
      editor.rows = Math.min(24, y.split('\n').length + 1);
      box.replaceChildren(editor);
    } else box.replaceChildren(y.trim() ? codeBlock(y, 'yaml') : h(`<div class="tip">No rules loaded: the request header / prompt token picks a built-in scenario.</div>`));
  };
  const drawSummary = () => {
    const r = runFor();
    const p = PROVIDERS.find((x) => x.id === provider);
    const flags = [r.stream && 'stream', r.tools && 'tools', r.structured && 'json_schema', r.agentLoop && 'agent loop', r.maxRetries && `maxRetries ${r.maxRetries}`, r.scenarioHeader && `x-mock-scenario: ${r.scenarioHeader}`, r.timeoutMs && `timeout ${r.timeoutMs}ms`].filter(Boolean);
    $('[data-slot=summary]', panel).innerHTML = `<b>${esc(p.sdk)}</b> · “${esc(r.prompt)}”${flags.length ? ' · ' + esc(flags.join(' · ')) : ''}`;
  };

  drawProviders();
  drawVariants();
  drawYaml();
  drawSummary();
  const results = createResults($('[data-slot=results]', panel), { focusTab: lesson.focusTab });

  panel.addEventListener('click', (e) => {
    const pb = e.target.closest('[data-p]');
    const vb = e.target.closest('[data-v]');
    if (pb) {
      provider = pb.dataset.p;
      store.set('provider', provider);
      drawProviders();
      drawSummary();
      go();
    } else if (vb) {
      variant = Number(vb.dataset.v);
      drawVariants();
      drawYaml();
      drawSummary();
      go();
    }
  });
  const go = async () => {
    const payload = { ...runFor(), provider, rules: editor ? editor.value : yamlFor() };
    await results.run(payload);
    if (results.state.finished && !done.has(lesson.id)) {
      done.add(lesson.id);
      store.set('done', [...done]);
      renderSidebar(lesson.id);
    }
  };
  $('[data-slot=go]', panel).addEventListener('click', go);
}

// ------------------------------------------------------------------ results component
function createResults(root, { focusTab } = {}) {
  const api = { state: {}, run };
  let tab = focusTab ?? 'conversation';
  root.innerHTML = `<div class="empty"><div><div style="font-size:26px;margin-bottom:6px">▶</div>Press <b>Run</b> to call the mock with the real SDK.</div></div>`;

  async function run(payload) {
    const btn = root.closest('.runpanel, .pg')?.querySelector('[data-slot=go]');
    if (btn) btn.disabled = true;
    api.state = { payload, provider: payload.provider, turns: [], status: 'running', startedAt: performance.now(), finished: false };
    render();
    try {
      const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) onEvent(ev, data ? JSON.parse(data) : {});
        }
      }
    } catch (e) {
      api.state.error = { name: 'PlaygroundError', message: `Could not reach the playground server: ${e.message}` };
    }
    api.state.status = api.state.error ? 'error' : 'ok';
    api.state.finished = true;
    api.state.elapsed = performance.now() - api.state.startedAt;
    if (btn) btn.disabled = false;
    render();
  }

  function turn(n) {
    let t = api.state.turns.find((x) => x.n === n);
    if (!t) api.state.turns.push((t = { n, text: '', streaming: true }));
    return t;
  }

  function onEvent(ev, d) {
    const s = api.state;
    if (ev === 'start') Object.assign(s, { model: d.model, baseUrl: d.baseUrl });
    else if (ev === 'turn-start') turn(d.turn);
    else if (ev === 'delta') {
      const t = turn(d.turn);
      t.text += d.text;
      const live = root.querySelector(`[data-live="${d.turn}"]`);
      if (live && tab === 'conversation') {
        live.textContent = t.text;
        return;
      }
    } else if (ev === 'turn') Object.assign(turn(d.turn), { text: d.text, stop: d.stop, toolCalls: d.toolCalls, raw: d.raw, streaming: false });
    else if (ev === 'tools') Object.assign(turn(d.turn), { results: d.results });
    else if (ev === 'error') {
      s.error = d;
      if (d.turn) turn(d.turn).streaming = false;
    } else if (ev === 'mockevent') {
      (s.events ??= []).push(d);
      if (tab !== 'events') return; // no re-render needed for other tabs
    } else if (ev === 'assertions') s.assertions = d.results;
    else if (ev === 'journal') Object.assign(s, { journal: d.entries, cost: d.cost, usage: d.usage, serverElapsed: d.elapsedMs });
    render();
  }

  function render() {
    const s = api.state;
    if (!s.status) return;
    const reqs = s.journal?.length ?? 0;
    const pill =
      s.status === 'running'
        ? `<span class="pill run"><span class="dot"></span>Running…</span>`
        : s.error
          ? `<span class="pill err"><span class="dot"></span>App received ${esc(s.error.name)}${s.error.status ? ` (${s.error.status})` : ''}</span>`
          : `<span class="pill ok"><span class="dot"></span>${s.payload.assertions?.length ? 'App run succeeded' : 'Success'}</span>`;
    const failing = s.assertions?.filter((a) => !a.pass).length ?? 0;
    const assertPill = s.assertions
      ? failing
        ? `<span class="pill err"><span class="dot"></span>${failing} assertion${failing === 1 ? '' : 's'} failed</span>`
        : `<span class="pill ok"><span class="dot"></span>${s.assertions.length} assertions passed</span>`
      : '';
    const failedAssertions = s.assertions?.filter((a) => !a.pass).length ?? 0;
    const tabs = [
      ...(s.payload.assertions?.length ? [['assertions', failedAssertions ? `Assertions ✗ ${failedAssertions}` : 'Assertions']] : []),
      ['conversation', 'Conversation'],
      ['sdk', 'SDK result'],
      ['wire', 'Wire', reqs],
      ['events', 'Events', s.events?.length],
      ['journal', 'Journal & cost'],
      ['code', 'App code'],
    ];
    root.innerHTML = `
      <div class="statusline">${pill}${assertPill}
        ${s.model ? `<span>${esc(s.model)}</span>` : ''}
        ${s.finished ? `<span>· ${Math.round(s.elapsed)} ms</span><span>· ${reqs} HTTP request${reqs === 1 ? '' : 's'}</span>` : ''}
      </div>
      <div class="tabs" role="tablist">${tabs
        .map(([id, label, count]) => `<button role="tab" type="button" data-tab="${id}" aria-selected="${tab === id}">${label}${count ? `<span class="count">${count}</span>` : ''}</button>`)
        .join('')}</div>
      <div class="tabpanel" role="tabpanel"></div>`;
    const panel = $('.tabpanel', root);
    if (tab === 'assertions' && !s.payload.assertions?.length) tab = 'conversation';
    if (tab === 'assertions') panel.append(renderAssertions(s));
    else if (tab === 'conversation') panel.append(renderConversation(s));
    else if (tab === 'sdk') panel.append(renderSdk(s));
    else if (tab === 'wire') panel.append(renderWire(s));
    else if (tab === 'journal') panel.append(renderJournal(s));
    else if (tab === 'events') panel.append(renderEvents(s));
    else panel.append(codeBlock(appCode(s.payload), 'ts'));
    root.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        render();
      }),
    );
  }
  return api;
}

function renderConversation(s) {
  const p = s.payload;
  const box = h(`<div class="convo"></div>`);
  if (p.system) box.append(h(`<div class="msg system"><div class="who">System</div><div class="bubble">${esc(p.system)}</div></div>`));
  box.append(h(`<div class="msg user"><div class="who">User${p.scenarioHeader ? ` <span class="badge">x-mock-scenario: ${esc(p.scenarioHeader)}</span>` : ''}</div><div class="bubble">${esc(p.prompt)}</div></div>`));
  for (const t of s.turns) {
    const stop = t.stop ? `<span class="badge ${/length|max|incomplete|SAFETY|MALFORMED|refusal|filter/i.test(t.stop) ? 'warn' : ''}">${esc(t.stop)}</span>` : '';
    const text = t.text ? esc(t.text) : t.streaming ? '' : `<span class="muted">(no text)</span>`;
    const msg = h(`<div class="msg assistant"><div class="who">Assistant · turn ${t.n} ${stop}</div><div class="bubble"><span data-live="${t.n}">${text}</span>${t.streaming && s.status === 'running' ? '<span class="cursor"></span>' : ''}</div></div>`);
    box.append(msg);
    if (t.toolCalls?.length) {
      const tc = h(`<div class="msg"><div class="who">Tool calls → demo app runs them</div><div class="toolcall"></div></div>`);
      t.toolCalls.forEach((c, i) => {
        const input = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
        $('.toolcall', tc).append(h(`<div class="call">🔧 ${esc(c.name)}(${esc(input)})</div>`));
        const r = t.results?.[i];
        if (r) $('.toolcall', tc).append(h(`<div class="result ${r.ok ? 'good' : 'bad'}">${r.ok ? '↩' : '⚠'} ${esc(JSON.stringify(r.output))}</div>`));
      });
      box.append(tc);
    }
  }
  if (s.error) {
    box.append(
      h(`<div class="errorbox"><div class="cls">throw ${esc(s.error.name)}${s.error.status ? ` · HTTP ${s.error.status}` : ''}</div><div class="msgtext">${esc(s.error.message)}</div></div>`),
    );
  }
  return box;
}

function renderAssertions(s) {
  const box = h(`<div class="convo"></div>`);
  if (!s.assertions) {
    box.append(h(`<div class="empty">Assertions run against the journal when the app finishes.</div>`));
    return box;
  }
  for (const a of s.assertions) {
    const item = h(`<details class="wire" ${a.pass ? '' : 'open'}><summary><span class="status ${a.pass ? 's2' : 's4'}" style="margin:0">${a.pass ? '✓' : '✗'}</span><span>${esc(a.label)}</span></summary><div class="wire-body"><pre>${esc(a.message)}</pre></div></details>`);
    box.append(item);
  }
  return box;
}

function renderEvents(s) {
  const box = h(`<div></div>`);
  box.append(
    h(`<p class="request-summary" style="white-space:normal;margin:0 0 10px">Emitted by <code>mock.on('request' | 'unmatched' | 'chunk' | 'response' | 'fault', …)</code>. Per request: request → unmatched? → chunk* → response | fault.</p>`),
  );
  if (!s.events?.length) {
    box.append(h(`<div class="empty">No events yet.</div>`));
    return box;
  }
  const rows = s.events
    .map((e) => {
      const detail =
        e.name === 'chunk'
          ? `${e.binary ? '[bytes] ' : ''}${esc(e.text)}`
          : e.name === 'request'
            ? `${esc(e.endpoint)} · matched by ${esc(e.matchedBy ?? 'nothing')}`
            : e.name === 'fault'
              ? `fault: ${esc(e.fault)} · status ${e.status || '—'}`
              : e.name === 'response'
                ? `status ${e.status}`
                : 'no rule matched';
      return `<tr><td class="mono">+${e.t}ms</td><td class="mono">#${e.id}</td><td class="mono">${e.name}${e.name === 'chunk' ? ` ${e.index}` : ''}</td><td class="mono" style="overflow-wrap:anywhere">${detail}</td></tr>`;
    })
    .join('');
  box.append(h(`<table class="grid"><thead><tr><th>Time</th><th>Req</th><th>Event</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`));
  return box;
}

function renderSdk(s) {
  const box = h(`<div class="convo"></div>`);
  if (!s.turns.some((t) => t.raw) && !s.error) box.append(h(`<div class="empty">Waiting for the SDK…</div>`));
  for (const t of s.turns) {
    if (!t.raw) continue;
    box.append(h(`<div class="section-label" style="margin:0">Turn ${t.n}: what the SDK returned to your code</div>`));
    box.append(codeBlock(pretty(t.raw), 'json'));
  }
  if (s.error) box.append(codeBlock(pretty({ thrown: s.error.name, status: s.error.status, message: s.error.message }), 'json'));
  return box;
}

const SHOW_REQ_HEADERS = ['content-type', 'authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'x-mock-scenario', 'x-mock-inject', 'x-amz-date', 'user-agent'];
// Never echo credentials: keep the auth scheme (e.g. "Bearer", "AWS4-HMAC-SHA256") and a 4-char key prefix.
const mask = (k, v) => {
  if (k === 'authorization') return v.split(/\s+/)[0] + ' ••••••';
  if (/api-key/.test(k)) return v.slice(0, 4) + '••••••';
  return v;
};

function renderWire(s) {
  const box = h(`<div></div>`);
  if (!s.journal) {
    box.append(h(`<div class="empty">The wire log appears when the run finishes.</div>`));
    return box;
  }
  if (!s.journal.length) box.append(h(`<div class="empty">No HTTP requests reached the mock.</div>`));
  s.journal.forEach((e, i) => {
    const w = e.wire;
    if (!w) return;
    const status = w.response.status ?? 0;
    const reqHeaders = Object.entries(w.request.headers).filter(([k]) => SHOW_REQ_HEADERS.includes(k));
    const resHeaders = Object.entries(w.response.headers ?? {});
    const reqBody = prettyMaybeJson(w.request.body);
    const resBody = prettyMaybeJson(w.response.body);
    const d = h(`<details class="wire" ${s.journal.length <= 2 || i === 0 ? 'open' : ''}>
      <summary><span class="method">${esc(w.request.method)}</span><span>${esc(w.request.url)}</span><span class="status s${String(status)[0]}">${status || 'no response'}</span></summary>
      <div class="wire-body">
        <h5>Request headers (selected)</h5>
        <div class="headers">${reqHeaders.map(([k, v]) => `<div><span>${esc(k)}:</span> ${esc(mask(k, v))}</div>`).join('') || '<div><span>none</span></div>'}</div>
        <h5>Request body</h5><div data-slot="reqbody"></div>
        <h5>Response headers</h5>
        <div class="headers">${resHeaders.map(([k, v]) => `<div><span>${esc(k)}:</span> ${esc(v)}</div>`).join('') || '<div><span>none sent</span></div>'}</div>
        <h5>Response body${/event-stream/.test(w.response.headers?.['content-type'] ?? '') ? ' (raw stream)' : ''}</h5><div data-slot="resbody"></div>
        ${w.response.aborted ? `<div class="aborted">✂ ${esc(w.response.aborted)}</div>` : ''}
        ${w.response.truncated ? `<div class="aborted">(body truncated in log)</div>` : ''}
      </div>
    </details>`);
    $('[data-slot=reqbody]', d).append(h(`<pre>${highlight(reqBody.text || '(empty)', reqBody.lang)}</pre>`));
    $('[data-slot=resbody]', d).append(h(`<pre>${highlight(resBody.text || '(empty)', resBody.lang)}</pre>`));
    box.append(d);
  });
  return box;
}

function renderJournal(s) {
  const box = h(`<div></div>`);
  if (!s.journal) {
    box.append(h(`<div class="empty">The journal appears when the run finishes.</div>`));
    return box;
  }
  const usd = s.cost.total;
  box.append(
    h(`<div class="costcard">
      <div class="stat"><div class="k">Requests</div><div class="v">${s.journal.length}</div></div>
      <div class="stat"><div class="k">Input tokens</div><div class="v">${s.usage.inputTokens.toLocaleString()}</div></div>
      <div class="stat"><div class="k">Output tokens</div><div class="v">${s.usage.outputTokens.toLocaleString()}</div></div>
      <div class="stat"><div class="k">Simulated cost</div><div class="v">${s.cost.unpriced.length && !usd ? '—' : `$${usd.toFixed(usd < 0.01 ? 5 : 3)}`}${s.cost.unpriced.length ? ` <small>${esc(s.cost.unpriced.join(', '))} unpriced</small>` : ''}</div></div>
    </div>`),
  );
  box.append(
    h(`<table class="grid"><thead><tr><th>#</th><th>Endpoint</th><th>Status</th><th>Matched by</th><th>Tokens in/out</th><th>ms</th></tr></thead><tbody>${s.journal
      .map(
        (e) =>
          `<tr><td>${e.id}</td><td class="mono">${esc(e.provider)} · ${esc(e.endpoint)}</td><td class="mono">${e.status || '—'}</td><td class="mono">${esc(e.matchedBy ?? 'built-in')}${e.fault ? ` · fault:${esc(e.fault.type)}` : ''}${e.chaos ? ` · chaos:${esc(e.chaos.behaviour)}` : ''}</td><td class="mono">${e.usage ? `${e.usage.inputTokens}/${e.usage.outputTokens}` : '—'}</td><td class="mono">${e.durationMs ?? '—'}</td></tr>`,
      )
      .join('')}</tbody></table>`),
  );
  s.journal.forEach((e) => {
    const d = h(`<details class="wire" style="margin-top:12px"><summary>Normalized request #${e.id}: what <code>mock.journal</code> sees</summary><div class="wire-body"></div></details>`);
    const { endpoint, provider, ...req } = e.request;
    $('.wire-body', d).append(codeBlock(pretty(req), 'json'));
    box.append(d);
  });
  return box;
}

// ------------------------------------------------------------------ "your app's code" for the chosen provider
function appCode(p) {
  const model = p.model || { openai: 'gpt-4o', 'openai-responses': 'gpt-4.1', anthropic: 'claude-opus-5-5', gemini: 'gemini-2.5-flash', bedrock: 'us.anthropic.claude-sonnet-5-5' }[p.provider];
  const prompt = JSON.stringify(p.prompt ?? '');
  const opt = (cond, text) => (cond ? text : '');
  const hdr = p.scenarioHeader ? `{ 'x-mock-scenario': '${p.scenarioHeader}' }` : '';
  switch (p.provider) {
    case 'openai-responses':
      return `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: mock.urls.openai,   // ← the only change for tests
  apiKey: 'test',${opt(p.maxRetries, `\n  maxRetries: ${p.maxRetries},`)}${opt(p.timeoutMs, `\n  timeout: ${p.timeoutMs},`)}${opt(hdr, `\n  defaultHeaders: ${hdr},`)}
});

const params = {
  model: '${model}',${opt(p.system, `\n  instructions: ${JSON.stringify(p.system)},`)}
  input: ${prompt},${opt(p.tools, `\n  tools: [{ type: 'function', name: 'get_weather', parameters, strict: true }],`)}${opt(p.structured, `\n  text: { format: { type: 'json_schema', name: 'review', schema } },`)}
};
${p.stream ? `const stream = client.responses.stream(params);
stream.on('response.output_text.delta', (e) => render(e.delta));
const response = await stream.finalResponse();` : `const response = await client.responses.create(params);`}
${p.agentLoop ? `
// agent loop: run function_call items, continue with previous_response_id
const calls = response.output.filter((o) => o.type === 'function_call');
await client.responses.create({
  model: '${model}',
  previous_response_id: response.id,
  input: calls.map((c) => ({ type: 'function_call_output', call_id: c.call_id, output: runTool(c) })),
});` : ''}`;
    case 'anthropic':
      return `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: mock.urls.anthropic,   // ← the only change for tests
  apiKey: 'test',${opt(p.maxRetries, `\n  maxRetries: ${p.maxRetries},`)}${opt(p.timeoutMs, `\n  timeout: ${p.timeoutMs},`)}${opt(hdr, `\n  defaultHeaders: ${hdr},`)}
});

const params = {
  model: '${model}',
  max_tokens: 1024,${opt(p.system, `\n  system: ${JSON.stringify(p.system)},`)}
  messages: [{ role: 'user', content: ${prompt} }],${opt(p.tools, `\n  tools: [{ name: 'get_weather', input_schema }],`)}${opt(p.structured, `\n  output_config: { format: { type: 'json_schema', schema } },`)}
};
${p.stream ? `const stream = client.messages.stream(params);
stream.on('text', (delta) => render(delta));
const message = await stream.finalMessage();` : `const message = await client.messages.create(params);`}
${p.agentLoop ? `
// agent loop: while stop_reason === 'tool_use', send tool_result blocks back
const toolUses = message.content.filter((b) => b.type === 'tool_use');
params.messages.push(
  { role: 'assistant', content: message.content },
  { role: 'user', content: toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: runTool(t) })) },
);` : ''}`;
    case 'gemini':
      return `import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: 'test',
  httpOptions: { baseUrl: mock.urls.gemini${opt(p.timeoutMs, `, timeout: ${p.timeoutMs}`)}${opt(hdr, `, headers: ${hdr}`)}${opt(p.maxRetries, `, retryOptions: { attempts: ${(p.maxRetries ?? 0) + 1} }`)} },   // ← the only change
});

const params = {
  model: '${model}',
  contents: ${prompt},
  config: {${opt(p.system, `\n    systemInstruction: ${JSON.stringify(p.system)},`)}${opt(p.tools, `\n    tools: [{ functionDeclarations: [{ name: 'get_weather', parametersJsonSchema }] }],`)}${opt(p.structured, `\n    responseMimeType: 'application/json',\n    responseJsonSchema: schema,`)}
  },
};
${p.stream ? `for await (const chunk of await ai.models.generateContentStream(params)) render(chunk.text);` : `const r = await ai.models.generateContent(params);
console.log(r.text, r.functionCalls);`}`;
    case 'bedrock':
      return `import { BedrockRuntimeClient, ${p.stream ? 'ConverseStreamCommand' : 'ConverseCommand'} } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({
  endpoint: mock.urls.bedrock,   // ← the only change for tests
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },${opt(p.maxRetries !== undefined, `\n  maxAttempts: ${(p.maxRetries ?? 0) + 1},`)}
});

const r = await client.send(new ${p.stream ? 'ConverseStreamCommand' : 'ConverseCommand'}({
  modelId: '${model}',${opt(p.system, `\n  system: [{ text: ${JSON.stringify(p.system)} }],`)}
  messages: [{ role: 'user', content: [{ text: ${prompt} }] }],${opt(p.tools, `\n  toolConfig: { tools: [{ toolSpec: { name: 'get_weather', inputSchema: { json } } }] },`)}
}));
${p.stream ? `for await (const ev of r.stream) render(ev.contentBlockDelta?.delta?.text ?? '');` : `console.log(r.output.message.content, r.stopReason);`}`;
    default:
      return `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: mock.urls.openai,   // ← the only change for tests
  apiKey: 'test',${opt(p.maxRetries, `\n  maxRetries: ${p.maxRetries},`)}${opt(p.timeoutMs, `\n  timeout: ${p.timeoutMs},`)}${opt(hdr, `\n  defaultHeaders: ${hdr},`)}
});

const params = {
  model: '${model}',
  messages: [${opt(p.system, `\n    { role: 'system', content: ${JSON.stringify(p.system)} },`)}
    { role: 'user', content: ${prompt} },
  ],${opt(p.tools, `\n  tools: [{ type: 'function', function: { name: 'get_weather', parameters } }],`)}${opt(p.structured, `\n  response_format: { type: 'json_schema', json_schema: { name: 'review', schema } },`)}
};
${p.stream ? `const stream = client.chat.completions.stream(params);
stream.on('content', (delta) => render(delta));
const completion = await stream.finalChatCompletion();` : `const completion = await client.chat.completions.create(params);`}
${p.agentLoop ? `
// agent loop: run tool_calls, append role: 'tool' messages, call again
const msg = completion.choices[0].message;
params.messages.push(msg, ...msg.tool_calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: runTool(c) })));` : ''}`;
  }
}

// ------------------------------------------------------------------ playground
const PG_DEFAULT = {
  provider: 'openai',
  model: '',
  prompt: "What's the weather in Paris?",
  system: '',
  stream: true,
  tools: true,
  structured: false,
  agentLoop: true,
  maxRetries: 0,
  timeoutMs: '',
  scenarioHeader: '',
  firstTokenMs: 0,
  tokensPerSec: 0,
  seed: 1,
  rules: LESSONS.find((l) => l.id === 'agent-loop').yaml,
};

async function renderPlayground() {
  document.title = 'Playground · mock-llm';
  const m = await meta();
  const s = { ...PG_DEFAULT, ...store.get('playground', {}) };
  const presets = LESSONS.filter((l) => !l.static).flatMap((l) => [
    { label: l.title, yaml: l.yaml, run: l.run },
    ...(l.variants ?? []).filter((v) => v.yaml).map((v) => ({ label: `${l.title}: ${v.label}`, yaml: v.yaml, run: { ...l.run, ...v.run } })),
  ]);
  const page = h(`<div class="page">
    <h1>Playground</h1>
    <p class="lead">Write any scenario, shape any request, and see exactly how each provider SDK experiences it. Everything runs against a fresh mock-llm with the official SDKs.</p>
    <div class="pg">
      <form class="form" autocomplete="off">
        <div class="fieldrow">
          <label class="field"><span>Provider SDK</span><select name="provider">${PROVIDERS.map((p) => `<option value="${p.id}">${esc(p.label)} (${esc(p.sdk)})</option>`).join('')}</select></label>
          <label class="field"><span>Model</span><input type="text" name="model" placeholder="default" /></label>
        </div>
        <label class="field"><span>User message</span><textarea name="prompt" rows="2"></textarea></label>
        <label class="field"><span>System prompt</span><input type="text" name="system" placeholder="(none)" /></label>
        <div class="toggles">
          ${[['stream', 'Stream'], ['tools', 'Offer get_weather tool'], ['agentLoop', 'Run agent loop'], ['structured', 'JSON schema output']].map(([k, l]) => `<label class="toggle"><input type="checkbox" name="${k}" /> ${l}</label>`).join('')}
        </div>
        <div class="fieldrow">
          <label class="field"><span>SDK max retries</span><input type="number" name="maxRetries" min="0" max="5" /></label>
          <label class="field"><span>Client timeout (ms)</span><input type="number" name="timeoutMs" min="100" step="100" placeholder="SDK default" /></label>
          <label class="field"><span>x-mock-scenario header</span><select name="scenarioHeader"><option value="">(none)</option>${m.scenarios.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
        </div>
        <div class="fieldrow">
          <label class="field"><span>First-token latency (ms)</span><input type="number" name="firstTokenMs" min="0" step="100" /></label>
          <label class="field"><span>Tokens / second (0 = instant)</span><input type="number" name="tokensPerSec" min="0" /></label>
          <label class="field"><span>Seed</span><input type="number" name="seed" /></label>
        </div>
        <div class="field">
          <span style="display:flex;justify-content:space-between;align-items:center;gap:10px">Scenario file (YAML or JSON)
            <select data-slot="preset" style="max-width:60%;font-size:13px;padding:4px 8px;border-radius:7px;border:1px solid var(--border-strong);background:var(--bg-elev);color:var(--text)"><option value="">Load a preset…</option>${presets.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('')}</select>
          </span>
          <textarea class="editor" name="rules" spellcheck="false" rows="14"></textarea>
        </div>
        <div class="runbar"><span class="request-summary">Tip: <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> runs.</span><button class="btn" type="button" data-slot="reset">Reset</button><button class="btn primary" type="submit" data-slot="go"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>Run</button></div>
      </form>
      <section class="runpanel" aria-label="Result"><div class="results" data-slot="results"></div></section>
    </div>
  </div>`);
  view.replaceChildren(page);
  const form = $('form', page);
  const fill = (v) => {
    for (const [k, val] of Object.entries(v)) {
      const input = form.elements[k];
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!val;
      else input.value = val ?? '';
    }
  };
  const read = () => {
    const v = {};
    for (const k of Object.keys(PG_DEFAULT)) {
      const input = form.elements[k];
      v[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
    }
    return v;
  };
  fill(s);
  const results = createResults($('[data-slot=results]', page));
  form.addEventListener('input', () => store.set('playground', read()));
  $('[data-slot=preset]', page).addEventListener('change', (e) => {
    const p = presets[Number(e.target.value)];
    if (!p) return;
    fill({ ...PG_DEFAULT, provider: form.elements.provider.value, ...p.run, rules: p.yaml, scenarioHeader: p.run.scenarioHeader ?? '' });
    store.set('playground', read());
    e.target.value = '';
  });
  $('[data-slot=reset]', page).addEventListener('click', () => {
    fill(PG_DEFAULT);
    store.set('playground', read());
  });
  const go = (e) => {
    e?.preventDefault();
    const v = read();
    results.run({
      ...v,
      maxRetries: v.maxRetries || 0,
      timeoutMs: v.timeoutMs || undefined,
      latency: v.firstTokenMs || v.tokensPerSec ? { firstTokenMs: v.firstTokenMs || 0, tokensPerSec: v.tokensPerSec || 0 } : undefined,
    });
  };
  form.addEventListener('submit', go);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(e);
  });
}

// ------------------------------------------------------------------ reference
const FAULT_DOCS = {
  badRequest: '400 invalid request',
  authError: '401 / native auth error (Gemini: 400 API_KEY_INVALID, Bedrock: UnrecognizedClientException)',
  permissionDenied: '403',
  notFound: '404 model / resource not found',
  contextLengthExceeded: '400 context length exceeded, with each provider\'s real message',
  requestTooLarge: '413 (400 on Gemini / Bedrock)',
  rateLimit: '429 + retry-after / retry-after-ms (Gemini RetryInfo, Bedrock ThrottlingException)',
  serverError: '500',
  overloaded: 'Anthropic 529 · OpenAI / Gemini 503 · Bedrock ServiceUnavailableException',
  raw: 'Any status, body and headers, sent verbatim',
  connectionReset: 'Destroy the socket (HTTP/2: reset the stream)',
  timeout: 'Accept the request and never answer',
  streamCut: 'Stream n chunks, then drop the connection',
  streamError: 'Stream n chunks, then (after a ~50 ms pause, as from the real API) send a native in-stream error event',
};
const EDGE_DOCS = {
  empty: 'Empty text content',
  codeFencedJson: 'JSON inside ```json fences with chatter around it',
  almostJson: 'Trailing comma + single quotes',
  truncated: 'Cut-off text with stop reason max_tokens',
  refusal: 'Model refusal (OpenAI message.refusal, Anthropic stop_reason refusal + stop_details)',
  contentFilter: 'Safety stop (OpenAI content_filter, Gemini SAFETY, Bedrock content_filtered)',
  unicode: 'Emoji, RTL, zalgo, zero-width characters',
  promptInjection: 'XSS / SQL / template-injection strings',
  piiLike: 'Email, phone, SSN, card and API-key-looking strings',
  long: 'Very long output (~N tokens)',
  malformedToolArgs: 'Tool call with invalid JSON arguments (Gemini: MALFORMED_FUNCTION_CALL)',
  hallucinatedTool: 'Call to a tool that was never offered',
  wrongToolArgTypes: 'Tool arguments of the wrong types',
};

async function renderReference() {
  document.title = 'Reference · mock-llm';
  const m = await meta();
  const row = (k, v) => `<tr><td><code>${esc(k)}</code></td><td>${v}</td></tr>`;
  const page = h(`<div class="ref">
    <h1>Reference</h1>
    <div class="toc">${['Scope', 'Install', 'Options', 'Matchers', 'Responders', 'Faults', 'Edge cases', 'Scenarios', 'Assertions', 'Journal', 'Events', 'Examples', 'Endpoints'].map((t) => `<a href="#/reference" data-jump="${t}">${t}</a>`).join('')}</div>

    <h2 id="Scope">Scope: what mock-llm is not</h2>
    <p>mock-llm is a <strong>library used inside your test framework</strong>. It controls what the model does and records what your app sent. It is deliberately not a test runner, a reporter or an eval tool. The full table, with what to use instead, is in the README's <a href="/docs/README.md#scope-what-mock-llm-is-not" target="_blank" rel="noopener"><code>Scope: what mock-llm is not</code></a> section.</p>
    <div class="tags">${['Assertions on app output', 'Semantic / LLM-as-judge assertions', '"Handles gracefully" assertions', 'Running suites & CLI seeds', 'Test reports', 'Production capture & OTel exporters', 'Runtime setProvider()'].map((t) => `<code>${esc(t)}</code>`).join('')}</div>

    <h2 id="Install">Install & set up</h2>
    <div data-slot="install"></div>
    <p>Requirements: Node ≥ 22, ESM. There are no runtime dependencies. <code>yaml</code>, <code>vitest</code>, <code>@jest/globals</code> and <code>@playwright/test</code> are optional peers, needed only for the feature that uses each one. The package is 0.x, so a minor release may change APIs; see <a href="/docs/CHANGELOG.md" target="_blank" rel="noopener"><code>CHANGELOG.md</code></a>. Releases are published from CI with npm provenance (<a href="/docs/RELEASING.md" target="_blank" rel="noopener"><code>RELEASING.md</code></a>).</p>

    <h2 id="Options">createMockLLM(options)</h2>
    <table class="grid"><tbody>
      ${row('port / host', 'Defaults: an ephemeral port on <code>127.0.0.1</code>. One port serves HTTP/1.1 and HTTP/2.')}
      ${row('seed', 'Deterministic lorem text, ids, schema values, chaos and random latency. <code>MOCK_LLM_SEED</code> overrides it; <code>mock.seed</code> is the effective seed. Strict reports, chaos error messages and matcher failures say how to reproduce.')}
      ${row('latency', '<code>{ firstTokenMs, tokensPerSec }</code>, off by default. <code>firstTokenMs</code> may be ms, <code>{ min, max }</code> or <code>{ distribution: \'normal\', mean, stdDev }</code> (seeded). Rules and steps override it.')}
      ${row('apiKeys', 'If set, requests must carry one of these keys or receive a native auth error.')}
      ${row('models', 'Ids returned by the models endpoints.')}
      ${row('chaos', '<code>{ rate, weights?, faults? }</code>: a seeded fraction of chat requests misbehave. <code>weights</code> over <code>error</code>, <code>refusal</code>, <code>empty</code>, <code>truncated</code> (your reply cut at max_tokens), <code>malformedToolCall</code> (only with tools). Default: errors only. Recorded as <code>entry.chaos = { seed, behaviour }</code>.')}
      ${row('strict', 'Unscripted chat requests get a native 400 and fail the test (<code>assertNoUnmatched()</code>, run automatically by <code>useMockLLM({ strict: true })</code>).')}
      ${row('onUnmatched', "<code>'reply'</code> (default canned reply) or <code>'error'</code> (400 without failing the test).")}
      ${row('pricing', 'USD per 1M tokens by model id / id fragment, merged over built-in Claude prices.')}
      ${row('scenarioFiles', 'YAML / JSON scenario files loaded on start.')}
      ${row('recordWire', 'Record raw HTTP in <code>journal</code> entries (default on).')}
      ${row('contextWindow', '<code>{ [modelId | glob]: tokens }</code>: oversized prompts get the native context-length error, before any rule. Tokens are <b>approximate</b> (~4 chars/token: system, messages incl. history, tool definitions; output not counted). Exact id wins, then the longest glob.')}
    </tbody></table>

    <h2 id="Matchers">Matchers: <code>mock.when(…)</code></h2>
    <p>A string or RegExp shorthand matches the last user message. <strong>The latest matching rule wins</strong>, and <code>.times(n)</code> / <code>.once()</code> let a rule expire.</p>
    <table class="grid"><tbody>
      ${row('provider', "<code>'openai' | 'anthropic' | 'gemini' | 'bedrock'</code> or a list")}
      ${row('model', 'Glob when it contains <code>*</code> / <code>?</code> (whole id, e.g. <code>\'claude-*\'</code>, <code>\'*claude-*\'</code> for Bedrock ids); otherwise substring; or RegExp')}
      ${row('lastUserMessage · system · anyMessage', 'Substring or RegExp')}
      ${row('hasTools · tool · tools', 'Tools offered / a tool with this name is offered / <em>all</em> of these tools are offered (others allowed)')}
      ${row('hasToolResult', 'The last turn carries tool results (agent loop continuation)')}
      ${row('turn', '1-based count of user turns')}
      ${row('stream · responseFormat', "Streaming request · <code>'text' | 'json_object' | 'json_schema'</code>")}
      ${row('headers · where', 'Header substring/RegExp map · custom predicate on the normalized request')}
    </tbody></table>

    <h2 id="Responders">Responders</h2>
    <table class="grid"><tbody>
      ${row('reply(text | IRResponse | { chunks } | fn, opts)', 'opts: <code>stopReason</code>, <code>thinking</code>, <code>usage</code>, <code>delay</code> (this step\'s first-token delay), <code>chunkIntervalMs</code>. <code>{ chunks: [...] }</code> streams exactly those pieces on every provider')}
      ${row('.latency({ firstTokenMs, tokensPerSec })', 'Latency for this rule (step <code>delay</code> > rule > global). Applied values are recorded as <code>entry.latency</code>')}
      ${row('replyTemplate', '<code>{{lastUserMessage}}</code>, <code>{{system}}</code>, <code>{{model}}</code>, <code>{{provider}}</code>')}
      ${row('replyEcho · replyLorem · replyJson', 'Echo the last user message · seeded filler · JSON text')}
      ${row('replyToolCall · replyToolCalls', 'One or parallel tool calls; a string input simulates malformed args')}
      ${row('replyFromSchema({ violate })', 'JSON generated from the request schema; <code>violate</code> breaks it')}
      ${row('replyToolCallFromSchema(name)', 'Tool args generated from the tool schema')}
      ${row('fail(fault)', 'Any fault below')}
      ${row('inject(text, { position })', 'Add text to every reply from this rule')}
      ${row('expectToolResult · expectRequest', 'Step options (and YAML step keys): check the request this step answers with the assertion core. Unmet expectations fail the test via the Vitest/Jest/Playwright helpers or <code>mock.assertExpectations()</code>')}
      ${row('.then', 'Readability sugar. Each responder appends a step and the last step repeats.')}
    </tbody></table>

    <h2 id="Faults">Faults: <code>faults.*</code></h2>
    <table class="grid"><tbody>${m.faults.map((f) => row(f, esc(FAULT_DOCS[f] ?? ''))).join('')}</tbody></table>

    <h2 id="Edge cases">Edge cases: <code>edge.*</code></h2>
    <table class="grid"><tbody>${m.edge.map((f) => row(f, esc(EDGE_DOCS[f] ?? ''))).join('')}</tbody></table>

    <h2 id="Scenarios">Built-in per-request scenarios</h2>
    <p>Select with the <code>x-mock-scenario</code> header or a <code>[[mock:name]]</code> token in the prompt. Define your own with <code>mock.scenario(name)</code>.</p>
    <div class="tags">${m.scenarios.map((s) => `<code>${esc(s)}</code>`).join('')}</div>

    <h2 id="Assertions">Assertions: <code>expect(mock)…</code></h2>
    <p>Registered by <code>import 'mock-llm/vitest'</code> or <code>'mock-llm/jest'</code> (or call the same functions exported from <code>mock-llm</code>, which return <code>{ pass, message }</code>). Objects match partially; RegExps and asymmetric matchers work anywhere; every matcher takes a <code>filter</code> (<code>{ provider, model, endpoint }</code>) and supports <code>.not</code>. The names avoid the built-in <code>toHaveBeenCalled*</code> spy matchers.</p>
    <table class="grid"><tbody>
      ${row('toHaveReceivedRequest(expected?)', 'Any chat request; with <code>expected</code>, one matching partially (model, provider, system, lastUserMessage, tools, stream, maxTokens, …)')}
      ${row('toHaveReceivedRequestTimes(n)', 'Exactly <code>n</code> chat requests')}
      ${row('toHaveReceivedPrompt(text, { in })', "System or user text matches; <code>in</code>: 'any' | 'system' | 'user' | 'lastUser'")}
      ${row('toHaveOfferedTool(name)', 'A request included the tool in its tool list')}
      ${row('toHaveRequestedTool(name, args?)', 'The <strong>mock</strong> asked the app to call it')}
      ${row('toHaveReturnedToolResult(name, expected?)', '<strong>Your app</strong> ran it and sent the result back (text/RegExp on raw content, object on parsed JSON)')}
      ${row('toHaveToolTrajectory(steps, { mode, source })', "Ordered tools; mode 'exact' | 'subsequence'; source 'returned' (app ran) | 'requested' (mock asked)")}
      ${row('toHaveUsedTokensLessThan(n, { kind })', "Simulated tokens below <code>n</code>; kind 'total' | 'input' | 'output'")}
      ${row('toCostLessThan(usd)', 'Simulated cost below <code>usd</code>; fails on unpriced models unless <code>allowUnpriced</code>')}
      ${row('toHaveNoUnmatchedRequests()', 'Every chat request was scripted (rule, scenario or default()); the failure is the UNEXPECTED LLM REQUEST report')}
      ${row('toHaveMetExpectations()', 'Every expectation step was met; the failure (SCENARIO EXPECTATION FAILED) names the scenario, rule and step')}
    </tbody></table>

    <h2 id="Journal">Journal</h2>
    <table class="grid"><tbody>
      ${row('journal.all(filter?) · last() · count()', 'Entries with the normalized request, response, fault, status, usage, duration and wire')}
      ${row('journal.usage(filter?)', 'Total simulated tokens')}
      ${row('journal.cost(filter?)', '<code>{ total, byModel, unpriced }</code> in USD')}
      ${row('mock.assertNoUnmatched()', 'Throws <code>UnmatchedRequestError</code> listing unscripted requests (entries carry <code>unmatched: true</code>)')}
      ${row('mock.assertExpectations()', 'Throws <code>ExpectationError</code> naming each unmet expectation step (entries carry <code>expectations</code>)')}
      ${row('GET /__mock/info · GET /__mock/journal', 'URLs, strict flag and pricing; the raw journal (out-of-process tests)')}
      ${row('POST /__mock/reset · POST /__mock/load', 'Clear everything; add rules from a scenario-file object. Client: <code>new RemoteMockLLM(url)</code>')}
    </tbody></table>

    <h2 id="Events">Events: <code>mock.on(event, listener)</code></h2>
    <p>Per request the order is always <code>request → unmatched? → chunk* → response | fault</code> (exactly one terminal event). Listeners receive the live journal <code>entry</code>, survive <code>reset()</code>, and can never break a response: throwing or rejecting listeners are reported via <code>console.error</code>. Remove with <code>mock.off(event, listener)</code>. Every lesson's <b>Events</b> tab shows these live.</p>
    <table class="grid"><tbody>
      ${row('request', '<code>{ entry }</code>: received and resolved (<code>matchedBy</code> / <code>unmatched</code> set). Always first')}
      ${row('unmatched', '<code>{ entry }</code>: no rule, scenario or default() matched (right after request)')}
      ${row('chunk', '<code>{ entry, index, data, text }</code>: one streamed piece as sent; <code>data</code> is a string or bytes, <code>text</code> is readable (Bedrock frames decoded)')}
      ${row('response', '<code>{ entry }</code>: finished without an injected fault, at any status (incl. validation errors)')}
      ${row('fault', '<code>{ entry, fault }</code>: an injected fault ended it (error, reset, timeout, stream cut / error)')}
    </tbody></table>

    <h2 id="Examples">Example projects</h2>
    <p>Standalone starter projects live in <code>examples/</code> in the repo. Each one pairs real app code with tests against mock-llm. Copy one to get started.</p>
    <table class="grid"><tbody>
      ${row('openai-support-bot', 'OpenAI Chat + Vitest: refusals, truncation, output escaping, retries, outages, timeouts, context window, seeded chaos (errors + content); <b>strict mode</b>; request / prompt / token matchers')}
      ${row('claude-tool-agent', 'Claude + Vitest: tool-use loops, parallel calls, hallucinated tools, runaway loops; <b>tool trajectory / tool result matchers</b>; model-glob + tools rules')}
      ${row('gemini-structured-extraction', 'Gemini + Vitest: JSON schema output, schema violations, repair-and-retry; request / prompt matchers')}
      ${row('bedrock-streaming-summarizer', 'Bedrock + Vitest: ConverseStream, mid-stream cuts, throttling, latency (incl. per-rule seeded random); <b>events</b> (<code>mock.on(\'chunk\')</code>); request matcher')}
      ${row('node-service-e2e', 'OpenAI & Claude + node:test: child-process service via mock.env(), YAML QA scenarios with expectation steps; assertions as plain functions')}
      ${row('jest-travel-assistant', 'OpenAI Responses API + <b>Jest</b> (ESM): mock-llm/jest, strict mode, tool loop via previous_response_id, conversation memory, matchers')}
      ${row('playwright-chat-ui', '<b>Playwright</b> full-stack: shared mock via globalSetup, llm.load scripting, routeBrowser, real-provider guard, strict mode, async matchers, mid-stream UI via exact chunks')}
      ${row('claude-code-cli', 'Run the real Claude Code CLI against the mock')}
    </tbody></table>

    <h2 id="Endpoints">Base URLs & endpoints</h2>
    <table class="grid"><tbody>
      ${row('mock.urls.openai', '<code>/v1/chat/completions</code>, <code>/v1/responses</code>, <code>/v1/embeddings</code>, <code>/v1/models</code>')}
      ${row('mock.urls.anthropic', '<code>/v1/messages</code>, <code>/v1/messages/count_tokens</code>, <code>/v1/models</code>')}
      ${row('mock.urls.gemini', '<code>/v1beta/models/{m}:generateContent | streamGenerateContent | countTokens | embedContent</code>, plus Vertex paths')}
      ${row('mock.urls.bedrock', '<code>/model/{id}/converse | converse-stream | invoke | invoke-with-response-stream | count-tokens</code>')}
    </tbody></table>
  </div>`);
  $('[data-slot=install]', page).append(
    codeBlock(
      `npm install -D mock-llm

import { createMockLLM, faults, edge } from 'mock-llm';
import { useMockLLM } from 'mock-llm/vitest';   // start/reset/stop per test file + matchers
// or: import { useMockLLM } from 'mock-llm/jest';  (Jest in ESM mode, see README)
// browser tests: import { test, expect } from 'mock-llm/playwright';

const mock = useMockLLM({ seed: 42, strict: true });`,
      'ts',
    ),
  );
  page.addEventListener('click', (e) => {
    const t = e.target.closest('[data-jump]');
    if (!t) return;
    e.preventDefault();
    document.getElementById(t.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  view.replaceChildren(page);
}

route();
