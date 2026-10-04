import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockLLM, ExpectationError, RemoteMockLLM, toHaveMetExpectations, type MockLLM } from '../../src/index.js';
import '../../src/testing/vitest.js';

let mock: MockLLM;
let dir: string | undefined;
afterEach(async () => {
  await mock?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const tools = [{ type: 'function' as const, function: { name: 'lookup_order', parameters: { type: 'object' } } }];
/** A real two-turn agent through the OpenAI SDK; returns the final answer. */
async function agent(m: MockLLM, toolOutput: unknown, system = 'You are Acme support.') {
  const c = new OpenAI({ baseURL: m.urls.openai, apiKey: 'k', maxRetries: 0 });
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: system }, { role: 'user', content: 'Can I get a refund for A-1?' }];
  const first = (await c.chat.completions.create({ model: 'gpt-4o', messages, tools })).choices[0]!.message;
  messages.push(first, { role: 'tool', tool_call_id: first.tool_calls![0]!.id, content: JSON.stringify(toolOutput) });
  return (await c.chat.completions.create({ model: 'gpt-4o', messages, tools })).choices[0]!.message.content;
}

const YAML = `rules:
  - name: refund-flow
    when: { tool: lookup_order }
    steps:
      - toolCall: { name: lookup_order, input: { order_id: A-1 } }
      - expectToolResult: { name: lookup_order, content: { refundable: true } }
        expectRequest: { system: "/acme support/i" }
        reply: You're eligible for a refund.
`;
const loadYaml = async (m: MockLLM) => {
  dir = mkdtempSync(join(tmpdir(), 'mock-llm-exp-'));
  const file = join(dir, 'support.yaml');
  writeFileSync(file, YAML);
  await m.load(file);
  return file;
};

describe('scenario-file expectation steps (checked with the R2 core)', () => {
  it('pass when the app sends the expected tool result and request', async () => {
    mock = await createMockLLM();
    await loadYaml(mock);
    expect(await agent(mock, { refundable: true, amount: 49.99 })).toBe("You're eligible for a refund.");
    expect(mock.journal.last()!.expectations!.map((e) => [e.kind, e.pass])).toEqual([
      ['expectToolResult', true],
      ['expectRequest', true],
    ]);
    expect(() => mock.assertExpectations()).not.toThrow();
    expect(mock).toHaveMetExpectations();
  });

  it('a failure names the scenario file, rule and step, with the core explanation; the reply is still sent', async () => {
    mock = await createMockLLM();
    const file = await loadYaml(mock);
    expect(await agent(mock, { refundable: false })).toBe("You're eligible for a refund."); // app flow continues

    let message = '';
    try {
      mock.assertExpectations();
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectationError);
      message = (e as Error).message;
    }
    expect(message).toContain('SCENARIO EXPECTATION FAILED: 1 expectation(s) not met.');
    expect(message).toMatch(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: rules\\[0\\] \\("refund-flow"\\) › steps\\[1\\]: expectToolResult \\(request #\\d+\\)`));
    expect(message).toContain('Expected mock-llm to have returned a tool result for "lookup_order" matching {"refundable":true}');
    expect(message).toContain('tool results sent: lookup_order→{"refundable":false}');
  });

  it('expectRequest failures are reported too (RegExp from "/…/i" strings)', async () => {
    mock = await createMockLLM();
    await loadYaml(mock);
    await agent(mock, { refundable: true }, 'You are a pirate.');
    expect(() => mock.assertExpectations()).toThrow(/steps\[1\]: expectRequest[\s\S]*matching \{"system":"\/acme support\/i"\}/);
    expect(mock).not.toHaveMetExpectations();
  });
});

describe('expectations in code (parity)', () => {
  it('named and numbered rules give readable step locations', async () => {
    mock = await createMockLLM();
    mock
      .when({ tool: 'lookup_order' }, 'refund')
      .replyToolCall('lookup_order', { order_id: 'A-1' })
      .then.reply('ok', { expectToolResult: { name: 'lookup_order', content: /refundable/ } });
    await agent(mock, { status: 'shipped' });
    expect(() => mock.assertExpectations()).toThrow(/rule "refund" › step 2: expectToolResult/);
    await mock.stop();

    mock = await createMockLLM();
    mock.when({}).reply('ok', { expectRequest: { model: 'claude-*' } });
    await new OpenAI({ baseURL: mock.urls.openai, apiKey: 'k' }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
    expect(() => mock.assertExpectations()).toThrow(/rule #1 › step 1: expectRequest/);
  });

  it('works remotely (Playwright path) and via the plain function', async () => {
    mock = await createMockLLM();
    await loadYaml(mock);
    await agent(mock, { refundable: false });
    await expect(new RemoteMockLLM(mock.urls.base).assertExpectations()).rejects.toBeInstanceOf(ExpectationError);
    expect(toHaveMetExpectations(mock).pass).toBe(false);
  });
});

describe('validation', () => {
  it('rejects malformed expectations with scenario locations', async () => {
    mock = await createMockLLM();
    await expect(mock.load({ rules: [{ steps: [{ reply: 'a', expectToolResult: { content: 'x' } as any }] }] })).rejects.toThrow(/^scenario: rules\[0\]\.steps\[0\]: expectToolResult needs \{ name, content\? \}/);
    await expect(mock.load({ rules: [{ reply: 'a', expectToolResult: { name: 't', contents: 1 } as any }] })).rejects.toThrow(/unknown key 'contents' in expectToolResult/);
    await expect(mock.load({ rules: [{ fail: 'overloaded', expectRequest: { model: 'x' } }] })).rejects.toThrow(/expectations are not supported on fail steps/);
    expect(() => mock.when({}).reply('a', { expectToolResult: {} as any })).toThrow(/invalid expectToolResult/);
  });
});

describe('useMockLLM fails a test with unmet expectations (even without strict)', () => {
  it('only the test whose app sent the wrong tool result fails', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mock-llm-exp-run-'));
    const outputFile = join(tmp, 'report.json');
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/fixtures/expectations/vitest.config.ts', '--reporter=json', `--outputFile=${outputFile}`],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    rmSync(tmp, { recursive: true, force: true });
    const results = Object.fromEntries(report.testResults[0].assertionResults.map((t: any) => [t.title, t]));
    expect(run.status).toBe(1);
    expect(results['agent sends the expected tool result'].status).toBe('passed');
    expect(results['agent sends the wrong tool result'].status).toBe('failed');
    expect(results['agent sends the wrong tool result'].failureMessages.join('\n')).toMatch(/SCENARIO EXPECTATION FAILED[\s\S]*rules\[0\] \("refund-flow"\) › steps\[1\]/);
  });
});
