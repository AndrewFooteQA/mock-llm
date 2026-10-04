import { expect, test } from 'mock-llm/playwright';

test.describe('Acme chat (server calls the LLM)', () => {
  test('answers an order question using the lookup tool', async ({ page, llm }) => {
    await llm.load({
      rules: [
        { when: { tool: 'lookup_order', hasToolResult: false }, toolCall: { name: 'lookup_order', input: { order_id: 'A-1001' } } },
        {
          when: { hasToolResult: true },
          // Checked by the llm fixture after the test (fails it if the server sent something else):
          expectToolResult: { name: 'lookup_order', content: { status: 'shipped' } },
          template: 'Your order A-1001 has shipped (ETA Oct 8).',
        },
      ],
    });

    await page.goto('/');
    await page.getByLabel('Message').fill('Where is order A-1001?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Your order A-1001 has shipped (ETA Oct 8).')).toBeVisible();

    // Assert on what the app's server sent to the model:
    await expect(llm).toHaveReceivedRequest({ system: expect.stringContaining('Acme Store'), tools: ['lookup_order'] });
    await expect(llm).toHaveToolTrajectory(['lookup_order']);
    await expect(llm).toHaveReturnedToolResult('lookup_order', { status: 'shipped' });
    await expect(llm).toHaveNoUnmatchedRequests();
  });

  test('shows a friendly message during an outage', async ({ page, llm }) => {
    await llm.load({ default: { fail: { overloaded: { retryAfter: 0 } } } });

    await page.goto('/');
    await page.getByLabel('Message').fill('Hello?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('The assistant is unavailable right now.')).toBeVisible();
    await expect(llm).toHaveReceivedRequestTimes(2); // the server's SDK retried once
  });

  test('renders a streamed answer', async ({ page, llm }) => {
    await llm.load({ default: { reply: 'Streaming works end to end, token by token.' } });

    await page.goto('/');
    await page.getByLabel('Message').fill('Tell me something');
    await page.getByRole('button', { name: 'Send (streaming)' }).click();
    await expect(page.getByText('Streaming works end to end, token by token.')).toBeVisible();
    await expect(llm).toHaveReceivedRequest({ stream: true });
  });

  test('renders partial text while the answer is still streaming', async ({ page, llm }) => {
    // Exact chunks with a fixed pause let the test observe the UI mid-stream. Keep the pause longer than one of
    // Playwright's assertion retry intervals (they back off to 1s), or toHaveText can poll before and after the
    // intermediate state and miss it, as Playwright 1.56 does with a 600 ms pause.
    await llm.load({ default: { reply: { chunks: ['Checking ', 'your order', '… it shipped!'] }, chunkIntervalMs: 1200 } });

    await page.goto('/');
    await page.getByLabel('Message').fill('Where is my order?');
    await page.getByRole('button', { name: 'Send (streaming)' }).click();
    const answer = page.locator('#messages p').last();
    await expect(answer).toHaveText('Checking your order'); // the intermediate state
    await expect(answer).toHaveText('Checking your order… it shipped!');
  });

  test('handles awkward model output safely (no HTML injection)', async ({ page, llm }) => {
    await llm.load({ default: { edge: 'promptInjection' } });

    await page.goto('/');
    await page.getByLabel('Message').fill('hi');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Ignore all previous instructions', { exact: false })).toBeVisible();
    await expect(page.locator('#messages script')).toHaveCount(0); // rendered as text, not markup
  });
});

test.describe('Bring your own key (browser calls the provider directly)', () => {
  test('routeBrowser sends the browser call to the mock', async ({ page, llm }) => {
    await llm.routeBrowser(page);
    await llm.load({ rules: [{ when: { model: 'gpt-4o-mini' }, reply: 'Acme: Everything You Need' }] });

    await page.goto('/');
    await page.getByRole('button', { name: 'Suggest a title' }).click();
    await expect(page.locator('#title')).toHaveText('Acme: Everything You Need');
    await expect(llm).toHaveReceivedRequest({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  // Deliberately failing tests (test.fail) that prove the safety nets fail a test loudly.
  test('without routeBrowser, a real provider call fails the test', async ({ page }) => {
    test.fail(true, 'blockRealProviders aborts the call to api.openai.com and fails the test');
    await page.goto('/');
    await page.getByRole('button', { name: 'Suggest a title' }).click();
    await expect(page.locator('#title')).toHaveText('Could not reach OpenAI.');
  });
});

test.describe('strict mode (llmStrict: true in playwright.config)', () => {
  test('an unscripted LLM call fails the test even though the app shows a friendly error', async ({ page, llm }) => {
    test.fail(true, 'strict mode: the request matched no rule');
    await llm.load({ rules: [{ when: { lastUserMessage: 'refund' }, reply: 'Refunds take 5 days.' }] });
    await page.goto('/');
    await page.getByLabel('Message').fill('Where is my order?'); // not scripted
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('The assistant is unavailable right now.')).toBeVisible();
  });
});
