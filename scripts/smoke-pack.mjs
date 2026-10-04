// Install the packed tarball into a fresh project (as users would) and check it works:
// a real request through the installed package, and types for every entry point.
// The project lives in .smoke/ inside the repo so optional peers (vitest, jest, playwright)
// resolve from the repo's devDependencies, while mock-llm itself comes only from the tarball.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, '.smoke');
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
const tgz = run('npm', ['pack', '--pack-destination', dir, '--ignore-scripts'], root).trim().split('\n').at(-1);
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mock-llm-smoke', private: true, type: 'module' }));
run('npm', ['install', `./${tgz}`, '--no-audit', '--no-fund', '--loglevel=error', '--offline']);

// 1) Runtime: start a mock from the installed package and make a real HTTP request.
writeFileSync(
  join(dir, 'runtime.mjs'),
  `import { createMockLLM } from 'mock-llm';
const mock = await createMockLLM();
mock.when('hi').reply('hello from the packed package');
const r = await fetch(mock.urls.openai + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }) });
const text = (await r.json()).choices[0].message.content;
await mock.stop();
if (text !== 'hello from the packed package') { console.error('unexpected reply', text); process.exit(1); }
console.log('  ✔ runtime: request served by the installed package');`,
);
process.stdout.write(run('node', ['runtime.mjs']));

// 2) Types: every entry point resolves with types from the installed package.
writeFileSync(
  join(dir, 'types.ts'),
  `import { createMockLLM, faults, toHaveOfferedTool, type MockLLM } from 'mock-llm';
import { useMockLLM as useVitest } from 'mock-llm/vitest';
import { useMockLLM as useJest } from 'mock-llm/jest';
import { test, expect, mockLLMEnv, startMockLLM } from 'mock-llm/playwright';
const m: Promise<MockLLM> = createMockLLM({ strict: true });
void m; void faults.rateLimit(); void toHaveOfferedTool; void useVitest; void useJest; void test; void expect; void mockLLMEnv(4010); void startMockLLM;
`,
);
run(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--types', 'node', 'types.ts']);
console.log('  ✔ types: mock-llm, mock-llm/vitest, mock-llm/jest, mock-llm/playwright');
rmSync(dir, { recursive: true, force: true });
