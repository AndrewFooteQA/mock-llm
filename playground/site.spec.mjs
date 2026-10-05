// The hosted (static) docs site works from recordings alone, under the Pages subpath.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LESSONS, PROVIDERS } from './public/lessons.js';

const meta = JSON.parse(readFileSync(new URL('../site/meta.json', import.meta.url), 'utf8'));

/** Fail the test on any console error, page error, failed response, or request to the live server's api/. */
function guard(page) {
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => /\/api\//.test(r.url()) && problems.push(`request to the live server: ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  return problems;
}

const results = (page) => page.locator('.results[data-status]').first();
async function runAndWait(page) {
  await page.locator('[data-slot=go]').first().click();
  await expect(results(page)).not.toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  await expect(page.locator('.pill.rec')).toContainText(/Recorded run · mock-llm v\d+\.\d+\.\d+/);
}

for (const lesson of LESSONS.filter((l) => !l.static)) {
  test(`lesson "${lesson.id}" replays its recording to the end`, async ({ page }) => {
    const problems = guard(page);
    await page.goto(`#/lesson/${lesson.id}`);
    await runAndWait(page);
    const expectError = (lesson.variants?.[0]?.expectError ?? lesson.expectError) === true;
    await expect(results(page)).toHaveAttribute('data-status', expectError ? 'error' : 'ok');
    expect(problems).toEqual([]);
  });
}

test('switching provider and variant replays the matching recording', async ({ page }) => {
  const problems = guard(page);
  const lesson = LESSONS.find((l) => !l.static && (l.variants?.length ?? 0) > 1 && !l.providers);
  await page.goto(`#/lesson/${lesson.id}`);
  for (const { id } of PROVIDERS) {
    await page.locator(`[data-p="${id}"]`).click();
    await runAndWait(page);
  }
  await page.locator('[data-v="1"]').click();
  await runAndWait(page);
  expect(problems).toEqual([]);
});

test('the Playground page replays its default run per provider, read-only, with "Run it live"', async ({ page }) => {
  const problems = guard(page);
  await page.goto('#/playground');
  await expect(page.locator('textarea[name=rules]')).toBeDisabled();
  await expect(page.getByRole('link', { name: /Run it live/ })).toHaveAttribute('href', /^https:\/\/stackblitz\.com\/github\/AndrewFooteQA\/mock-llm\/tree\/v\d/);
  for (const { id } of PROVIDERS) {
    await page.locator('select[name=provider]').selectOption(id);
    await runAndWait(page);
  }
  expect(problems).toEqual([]);
});

test('the Reference page lists faults, edge cases and scenarios from meta.json, and its docs links resolve', async ({ page, request }) => {
  const problems = guard(page);
  await page.goto('#/reference');
  for (const name of [...meta.faults, ...meta.scenarios.slice(0, 5)]) await expect(page.locator('#view')).toContainText(name);
  const hrefs = await page.locator('a[href^="docs/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href').split('#')[0]));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of new Set(hrefs)) expect((await request.get(href)).status(), href).toBe(200);
  expect(problems).toEqual([]);
});

test('an edited scenario explains it is not recorded instead of failing silently', async ({ page }) => {
  const editable = LESSONS.find((l) => l.editable);
  await page.goto(`#/lesson/${editable.id}`);
  await expect(page.locator('textarea.editor')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('link', { name: /Run it live/ })).toBeVisible();
});

test('screenshot of a lesson run, published with the site (the README shows it from the Pages URL)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('#/lesson/agent-loop');
  await runAndWait(page);
  await page.screenshot({ path: fileURLToPath(new URL('../site/screenshot.png', import.meta.url)) });
});
