import { defineConfig } from '@playwright/test';
import { mockLLMEnv } from 'mock-llm/playwright';

const MOCK_PORT = 4010;
const APP_PORT = 4321;

export default defineConfig({
  testDir: './tests',
  // One mock serves the whole run, so tests that script it must not run in parallel.
  workers: 1,
  // Starts mock-llm on MOCK_PORT (Playwright runs this after webServer has started; the app
  // only calls the LLM while handling requests, which happens during tests).
  globalSetup: './tests/global-setup.mjs',
  webServer: {
    command: 'node server.mjs',
    url: `http://127.0.0.1:${APP_PORT}`,
    env: { ...mockLLMEnv(MOCK_PORT), PORT: String(APP_PORT) },
  },
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    // After each test, fail if the app made an LLM request no rule scripted.
    llmStrict: true,
  },
  // The JSON report is also checked by `posttest`: deliberate-failure tests must fail for the right reason.
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
