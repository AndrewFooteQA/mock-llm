// End-to-end: run the real service as a child process, pointed at mock-llm
// purely through environment variables (mock.env()). Uses the built-in
// node:test runner, with no build step and no test framework.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { builtinScenarios, createMockLLM, ExpectationError, toHaveMetExpectations, toHaveReceivedRequest } from 'mock-llm';

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

const chat = (svc, message, headers = {}) =>
  fetch(`${svc.url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ message }) });

for (const provider of ['openai', 'anthropic']) {
  describe(`service backed by ${provider}`, () => {
    let mock;
    let svc;

    before(async () => {
      mock = await createMockLLM({ scenarioFiles: ['qa/scenarios.yaml'] });
      svc = await startService({ ...mock.env(), LLM_PROVIDER: provider, LLM_FORWARD_HEADERS: 'x-request-id, x-mock-scenario', LLM_TIMEOUT_MS: '3000' });
      // LLM_TIMEOUT_MS: short, so the `timeout` scenario in the sweep below fails fast, but longer than a 429's
      // retry-after (1 s) plus the retry, so a rate limit still surfaces as a 429 rather than a timeout.
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
      assert.match(stripVTControlCharacters(svc.stderr()), /upstream error: 429/); // console.error colours numbers under FORCE_COLOR
    });

    it('picks a scenario per request from a forwarded x-mock-scenario header (no code changes)', async () => {
      // A scenario from the QA file, then a built-in one, for the same question.
      const vip = await chat(svc, 'Do you sell spaceships?', { 'x-mock-scenario': 'vip', 'x-request-id': 'req-42' });
      assert.match((await vip.json()).reply, /As a VIP you get free express shipping/);
      const r = toHaveReceivedRequest(mock, { headers: { 'x-request-id': 'req-42', 'x-mock-scenario': 'vip' } });
      assert.ok(r.pass, r.message());

      const down = await chat(svc, 'Do you sell spaceships?', { 'x-mock-scenario': 'rate-limit' });
      assert.equal(down.status, 503);
    });

    it('routes on a forwarded header in the QA file (beta testers)', async () => {
      const r = await chat(svc, 'Do you sell spaceships?', { 'x-request-id': 'beta-007' });
      assert.match((await r.json()).reply, /Thanks for testing the beta/);
    });

    it('serves the QA file scenarios: echo, filler text and structured JSON', async () => {
      const echo = await (await chat(svc, 'Ping 123', { 'x-mock-scenario': 'echo' })).json();
      assert.match(echo.reply, /Ping 123/);
      const filler = await (await chat(svc, 'Anything', { 'x-mock-scenario': 'filler' })).json();
      assert.ok(filler.reply.split(/\s+/).length > 10);
      const structured = await (await chat(svc, 'Anything', { 'x-mock-scenario': 'structured' })).json();
      assert.deepEqual(JSON.parse(structured.reply), { answer: 'Open daily', confidence: 0.9 });
    });

    it('survives every built-in scenario: a reply or a clean 503, never a crash', async () => {
      // A QA sweep: each built-in failure mode or awkward output, picked per request with the forwarded header.
      for (const name of Object.keys(builtinScenarios)) {
        const r = await chat(svc, 'Where is my order?', { 'x-mock-scenario': name });
        assert.ok([200, 503].includes(r.status), `${name}: HTTP ${r.status}`);
        const body = await r.json();
        assert.ok(r.status === 200 ? typeof body.reply === 'string' : body.error === 'assistant_unavailable', `${name}: ${JSON.stringify(body)}`);
      }
      const r = await chat(svc, 'Still alive?');
      assert.equal(r.status, 200); // and the service is still up afterwards
    });

    it('reports an unmet QA expectation as an ExpectationError (and as a plain assertion result)', async () => {
      mock.when({ lastUserMessage: 'audit' }).reply('ok', { expectRequest: { system: '/a different system prompt/' } });
      await chat(svc, 'audit');
      const r = toHaveMetExpectations(mock);
      assert.equal(r.pass, false);
      assert.match(r.message(), /expectRequest/);
      assert.throws(() => mock.assertExpectations(), ExpectationError);
      mock.journal.clear(); // acknowledged: later tests check expectations again
    });

    it('falls back to the default reply', async () => {
      const r = await chat(svc, 'Do you sell spaceships?');
      assert.match((await r.json()).reply, /connect you with a human/);
    });
  });
}
