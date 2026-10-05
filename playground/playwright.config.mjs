import { defineConfig } from '@playwright/test';

// Smoke test of the static GitHub Pages build (site/), served under /mock-llm/ like Pages does.
// Build it first: npm run playground:build (npm run test:site does both).
// SITE_URL=https://andrewfooteqa.github.io/mock-llm/ runs the same tests against the deployed site instead.
const PORT = 4318;
const live = process.env.SITE_URL;
export default defineConfig({
  testDir: '.',
  testMatch: 'site.spec.mjs',
  fullyParallel: true,
  reporter: [['list']],
  ...(live ? {} : { webServer: { command: `node serve-site.mjs ${PORT}`, url: `http://127.0.0.1:${PORT}/mock-llm/`, reuseExistingServer: false } }),
  use: { baseURL: live ?? `http://127.0.0.1:${PORT}/mock-llm/` },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
