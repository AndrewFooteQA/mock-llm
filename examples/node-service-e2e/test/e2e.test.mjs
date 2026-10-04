// End-to-end: run the real service as a child process, pointed at mock-llm
// purely through environment variables (mock.env()). Uses the built-in
// node:test runner, with no build step and no test framework.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMockLLM, toHaveReceivedRequest } from 'mock-llm';

const root = fileURLToPath(new URL('..', import.meta.url));

async function startService(env) {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: { ...process.env, ...env, PORT: '0' } });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const [line] = await once(child.stdout, 'data');
  const port = String(line).match(/listening on (\d+)/)[1];
  return {
    url: `http://127.0.0.1:${port}`,
    stderr: () => stderr,
    stop: () => child.kill(),
  };
}

const chat = (svc, message) =>
  fetch(`${svc.url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });

for (const provider of ['openai', 'anthropic']) {
  describe(`service backed by ${provider}`, () => {
    let mock;
    let svc;

    before(async () => {
      mock = await createMockLLM({ scenarioFiles: ['qa/scenarios.yaml'] });
      svc = await startService({ ...mock.env(), LLM_PROVIDER: provider });
    });
    after(async () => {
      svc?.stop();
      await mock?.stop();
    });

    it('answers from the QA scenario file', async () => {
      const r = await chat(svc, 'How do I get a refund?');
      assert.equal(r.status, 200);
      assert.match((await r.json()).reply, /5 business days/);
      mock.assertExpectations(); // the scenario's expectRequest (system prompt) was met
    });

    it('sends the system prompt to the right provider', async () => {
      await chat(svc, 'When are you open?');
      // mock-llm's assertions are plain functions, so they work with any test framework:
      const r = toHaveReceivedRequest(mock, { provider, system: /Acme Store assistant/, lastUserMessage: 'When are you open?' });
      assert.ok(r.pass, r.message());
    });

    it('rides out a transient overload with one SDK retry', async () => {
      const r = await chat(svc, 'flaky question');
      assert.equal(r.status, 200);
      assert.deepEqual(mock.journal.all().slice(-2).map((e) => e.status), [provider === 'anthropic' ? 529 : 503, 200]);
    });

    it('returns 503 when the LLM keeps failing (no code changes: prompt token)', async () => {
      const r = await chat(svc, 'Hello [[mock:rate-limit]]');
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: 'assistant_unavailable' });
      assert.match(svc.stderr(), /upstream error: 429/);
    });

    it('falls back to the default reply', async () => {
      const r = await chat(svc, 'Do you sell spaceships?');
      assert.match((await r.json()).reply, /connect you with a human/);
    });
  });
}
