import { defineConfig } from '@playwright/test';

// Smoke test of the static GitHub Pages build (site/), served under /mock-llm/ like Pages does.
// Build it first: npm run playground:build (npm run test:site does both).
const PORT = 4318;
export default defineConfig({
  testDir: '.',
  testMatch: 'site.spec.mjs',
  fullyParallel: true,
  reporter: [['list']],
  webServer: { command: `node serve-site.mjs ${PORT}`, url: `http://127.0.0.1:${PORT}/mock-llm/`, reuseExistingServer: false },
  use: { baseURL: `http://127.0.0.1:${PORT}/mock-llm/` },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
