// Tutorial content. Each lesson's `yaml` is a real mock-llm scenario file that the
// playground server loads; `run` describes what the demo app sends. `test` is the
// equivalent code you'd write in your own test suite. `expectError` (lesson or
// variant) marks runs that are *supposed* to end in an SDK error; `npm run
// playground:check` verifies every run against it. Runs must not make unscripted
// requests unless `allowUnmatched` is true (or lists the providers that may).

export const PROVIDERS = [
  { id: 'openai', label: 'OpenAI Chat', sdk: 'openai' },
  { id: 'openai-responses', label: 'OpenAI Responses', sdk: 'openai' },
  { id: 'anthropic', label: 'Claude', sdk: '@anthropic-ai/sdk' },
  { id: 'gemini', label: 'Gemini', sdk: '@google/genai' },
  { id: 'bedrock', label: 'Bedrock', sdk: '@aws-sdk/client-bedrock-runtime' },
];

export const LESSONS = [
  {
    id: 'first-mock',
    group: 'Getting started',
    title: 'Your first mock',
    intro: `
      <p><strong>mock-llm</strong> is a local server that speaks the real wire protocols of OpenAI, Anthropic, Gemini and Bedrock.
      Your app keeps using the <em>official SDKs</em>. You only point them at the mock's base URL, so no tokens are spent and responses are deterministic.</p>
      <p>Press <kbd>Run</kbd>. The playground starts a fresh mock, loads the scenario below, and calls it with the SDK for the provider you picked.
      Switch providers and run again: <strong>the same rules work everywhere</strong>, because mock-llm translates every request into one provider-neutral form.</p>`,
    test: `import OpenAI from 'openai';
import { createMockLLM } from 'mock-llm';

const mock = await createMockLLM();
mock.default().reply('Hello from mock-llm! 👋');

// The only change to your app: the base URL.
const openai = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test' });
const r = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hi there' }],
});
expect(r.choices[0].message.content).toBe('Hello from mock-llm! 👋');

await mock.stop();`,
    yaml: `default:
  reply: "Hello from mock-llm! 👋"`,
    run: { prompt: 'Hi there' },
    tip: 'Open the <b>Wire</b> tab to see the exact HTTP the SDK sent and the provider-native JSON the mock returned.',
  },
  {
    id: 'matching',
    group: 'Getting started',
    title: 'Matching requests',
    intro: `
      <p>Rules choose a reply based on the request. A plain string matches a substring of the <em>last user message</em>, and <code>/…/flags</code> is a regex.
      You can also match on <code>system</code>, <code>model</code>, <code>provider</code>, <code>tool</code> / <code>tools</code>, <code>hasToolResult</code>, <code>turn</code>, <code>stream</code>, headers, or a custom predicate.
      A <code>model</code> with <code>*</code> or <code>?</code> is a glob over the whole id: try <b>Model globs</b> and switch providers.</p>
      <p><strong>The most recently added matching rule wins.</strong> That lets a single test override rules shared from a <code>beforeEach</code>. Try each variant.</p>`,
    test: `mock.when(/refund/i).reply('Refunds take 5 business days.');
mock.when('shipping').reply('Orders ship within 24 hours.');
mock.when({ system: 'pirate' }).replyTemplate('Arr! Ye asked: {{lastUserMessage}}');
mock.when({ model: '*claude-*' }).reply('Claude family');          // glob: claude-opus-5-5, us.anthropic.claude-…
mock.when({ tools: ['search', 'purchase'] }).reply('Shopping agent'); // all of these tools offered
mock.default().reply("Sorry, I didn't catch that.");`,
    yaml: `rules:
  - when: { lastUserMessage: "/refund/i" }
    reply: Refunds take 5 business days.
  - when: { lastUserMessage: shipping }
    reply: Orders ship within 24 hours.
  - when: { system: pirate }
    template: "Arr! Ye asked: {{lastUserMessage}}"
default:
  reply: "Sorry, I didn't catch that."`,
    run: { prompt: 'Can I get a REFUND?' },
    variants: [
      { label: '"Can I get a REFUND?"', run: { prompt: 'Can I get a REFUND?' } },
      { label: '"Where is my shipping?"', run: { prompt: 'Where is my shipping?' } },
      { label: 'Pirate system prompt', run: { prompt: 'Where is the treasure?', system: 'You are a pirate.' } },
      { label: 'No match → default', run: { prompt: 'Tell me a joke' } },
      {
        label: 'Model globs (switch providers)',
        yaml: `rules:
  - when: { model: "gpt-*" }
    template: "OpenAI family rule matched {{model}}"
  - when: { model: "*claude-*" }
    template: "Claude family rule matched {{model}}"
  - when: { model: "gemini-*" }
    template: "Gemini family rule matched {{model}}"`,
        run: { prompt: 'Which rule answers me?' },
      },
      {
        label: 'All of these tools offered',
        yaml: `rules:
  - when: { tools: [get_weather] }
    reply: You offered get_weather, so the weather agent answers.
default:
  reply: No tools offered.`,
        run: { prompt: 'Hi', tools: true },
      },
    ],
  },
  {
    id: 'streaming',
    group: 'Getting started',
    title: 'Streaming & latency',
    intro: `
      <p>Each adapter emits the provider's real streaming format: OpenAI <code>chat.completion.chunk</code>s ending in <code>[DONE]</code>, Anthropic
      <code>message_start → content_block_delta → message_stop</code>, Gemini SSE chunks, and Bedrock's <em>binary</em> AWS event stream.
      The SDKs' own stream helpers reassemble them.</p>
      <p>Latency is off by default so tests stay fast. Turn it on to test spinners, timeouts and "time to first token" handling.
      The first variant uses a global <code>firstTokenMs: 600</code> and <code>tokensPerSec: 12</code>, so watch the text arrive.</p>
      <p>Latency can also be set per rule (<code>.latency()</code>) or per step (<code>{ delay }</code>), and delays can be random:
      <code>{ min, max }</code> or <code>{ distribution: 'normal', mean, stdDev }</code>, drawn from a seeded stream so a failing test replays identically.
      The <b>Events</b> tab shows the timing; each journal entry records the delay it got (<code>entry.latency</code>).</p>
      <p>To control the exact pieces (e.g. JSON arriving in fragments, or partial text a UI must render), use <code>reply({ chunks: [...] }, { chunkIntervalMs })</code>.
      Try <b>Exact chunks</b> and compare the Wire and Events tabs across providers.</p>`,
    test: `const mock = await createMockLLM({
  latency: { firstTokenMs: 600, tokensPerSec: 12 },
});
mock.default().reply('Streaming works across every provider, one token at a time.', {
  thinking: 'The user wants to see streaming.',   // also streams a thinking block where supported
});

// Per rule / per step, and seeded random delays:
mock.when({ tool: 'get_weather' })
  .latency({ tokensPerSec: 20 })
  .replyToolCall('get_weather', { city: 'Paris' }, { delay: 1200 })
  .then.reply('It is sunny.', { delay: 300 });
mock.when('slow').latency({ firstTokenMs: { distribution: 'normal', mean: 900, stdDev: 300 } }).reply('…');

// Exact stream pieces (every provider), with a fixed pause between them:
mock.when('json').reply({ chunks: ['{"sta', 'tus": "ok', '"}'] }, { chunkIntervalMs: 400 });
const { firstTokenMs } = mock.journal.last().latency; // identical on every run with the same seed

const stream = claude.messages.stream({ model, max_tokens: 1024, messages });
stream.on('text', (delta) => render(delta));
const final = await stream.finalMessage();`,
    yaml: `default:
  reply: Streaming works across every provider, one token at a time. Each word is a separate wire event.
  thinking: The user wants to see streaming.`,
    run: { prompt: 'Stream something', stream: true, latency: { firstTokenMs: 600, tokensPerSec: 12 } },
    variants: [
      { label: 'Global latency' },
      {
        label: 'Per-step delays (slow agent)',
        yaml: `rules:
  - when: { tool: get_weather }
    latency: { tokensPerSec: 20 }
    steps:
      - toolCall: { name: get_weather, input: { city: Paris } }
        delay: 1200
      - reply: It is 21°C and sunny in Paris.
        delay: 300`,
        run: { prompt: "What's the weather in Paris?", tools: true, agentLoop: true, latency: undefined },
      },
      {
        label: 'Exact chunks',
        yaml: `default:
  reply:
    chunks: ['{"sta', 'tus": "o', 'k", "items": [1, ', '2, 3]}', ' 👩🏽‍💻']
  chunkIntervalMs: 400`,
        run: { latency: undefined },
      },
      {
        label: 'Random latency (seeded)',
        yaml: `rules:
  - when: {}
    latency:
      firstTokenMs: { distribution: normal, mean: 900, stdDev: 300 }
      tokensPerSec: 15
    reply: Each run with the same seed waits exactly as long. Change the seed in the Playground to see a different delay.`,
        run: { latency: undefined },
      },
    ],
  },
  {
    id: 'agent-loop',
    group: 'Agents & structured output',
    title: 'Tool-calling agent loops',
    intro: `
      <p>Every <code>reply*</code> call adds a <strong>step</strong>, and requests that match the rule walk through the steps. That makes a scripted agent loop easy:
      first ask the app to call a tool, then answer once the tool result comes back.</p>
      <p>The demo app here is a real agent loop. It runs <code>get_weather</code> locally and sends the result back using each SDK's native tool-result format
      (<code>role: "tool"</code>, <code>tool_result</code> blocks, <code>functionResponse</code>, <code>toolResult</code>…).</p>`,
    test: `mock.when({ tool: 'get_weather' })
  .replyToolCall('get_weather', { city: 'Paris' })
  .then.reply('It is 21°C and sunny in Paris.');

// or route on conversation state instead of order:
mock.when({ tool: 'get_weather' }).replyToolCall('get_weather', { city: 'Paris' });
mock.when({ hasToolResult: true }).reply('It is 21°C and sunny in Paris.');

// assert on what your agent sent back:
const last = mock.journal.last().request.messages.at(-1);
expect(last.content[0]).toMatchObject({ type: 'tool_result' });`,
    yaml: `rules:
  - when: { tool: get_weather }
    steps:
      - toolCall: { name: get_weather, input: { city: Paris }, text: Let me check. }
      - reply: It is 21°C and sunny in Paris.`,
    run: { prompt: "What's the weather in Paris?", tools: true, agentLoop: true, stream: true },
    variants: [
      { label: 'Happy path' },
      {
        label: 'Parallel tool calls',
        yaml: `rules:
  - when: { tool: get_weather }
    steps:
      - toolCalls:
          - { name: get_weather, input: { city: Paris } }
          - { name: get_weather, input: { city: Tokyo } }
      - reply: Paris and Tokyo are both 21°C.`,
      },
      {
        label: 'Schema-generated args',
        yaml: `rules:
  - when: { tool: get_weather }
    steps:
      - toolCallFromSchema: get_weather
      - template: "Got the weather. (model: {{model}})"`,
      },
    ],
  },
  {
    id: 'structured',
    group: 'Agents & structured output',
    title: 'Structured output',
    intro: `
      <p><code>replyFromSchema()</code> generates JSON from whatever schema the request carries: OpenAI <code>response_format</code> / <code>text.format</code>,
      Anthropic <code>output_config.format</code>, or Gemini <code>responseJsonSchema</code>. Values are deterministic and respect enums, formats, bounds and <code>required</code>.</p>
      <p>Use <code>{ violate: true }</code> to return JSON that <em>breaks</em> the schema, and check that your validation actually catches it.
      (Bedrock Converse requests carry no schema, so the <code>json_schema</code> rule doesn't match and you get the default reply. That's a good reminder that matchers see the real request.)</p>`,
    test: `mock.when({ responseFormat: 'json_schema' }).replyFromSchema();

const r = await openai.chat.completions.create({
  model, messages,
  response_format: { type: 'json_schema', json_schema: { name: 'review', schema } },
});
expect(Review.safeParse(JSON.parse(r.choices[0].message.content)).success).toBe(true);

// negative test: your validator should reject this
mock.when({ responseFormat: 'json_schema' }).replyFromSchema({ violate: true });`,
    yaml: `rules:
  - when: { responseFormat: json_schema }
    fromSchema: {}`,
    run: { prompt: 'Review this product', structured: true },
    variants: [
      // Bedrock requests carry no schema, so they intentionally fall through to the default reply.
      { label: 'Valid JSON', allowUnmatched: ['bedrock'] },
      { label: 'Schema violation', yaml: `rules:\n  - when: { responseFormat: json_schema }\n    fromSchema: { violate: true }`, allowUnmatched: ['bedrock'] },
      { label: 'Code-fenced JSON', yaml: `default:\n  edge: { codeFencedJson: { title: Great, rating: 5 } }` },
      { label: 'Almost-JSON', yaml: `default:\n  edge: { almostJson: { title: Great, rating: 5 } }` },
    ],
    providers: ['openai', 'openai-responses', 'anthropic', 'gemini', 'bedrock'],
  },
  {
    id: 'retries',
    group: 'Negative testing',
    title: 'Rate limits & retries',
    intro: `
      <p>Faults render in each provider's <strong>native error envelope and status code</strong>, so the SDKs raise their real exception classes and run their real retry logic.
      <code>retryAfter</code> sets both <code>retry-after</code> and <code>retry-after-ms</code>.</p>
      <p>This scenario returns a 429 <em>once</em> and then succeeds. With retries off, your app sees the error. With retries on, the SDK recovers,
      and the Journal shows <code>429 → 200</code>.</p>
      <p><b>Chaos (seeded)</b> injects random rate limits and outages instead (<code>chaos: { rate }</code>). The error your app receives names the seed,
      e.g. <code>[mock-llm chaos fault · seed 2024 · reproduce with MOCK_LLM_SEED=2024]</code>, so a flaky CI failure can be replayed exactly with
      <code>MOCK_LLM_SEED=2024 npm test</code>.</p>`,
    test: `mock.when({}).reply('ok');
mock.when({}).once().fail(faults.rateLimit({ retryAfter: 0.5 }));

const client = new OpenAI({ baseURL: mock.urls.openai, apiKey: 'test', maxRetries: 2 });
await client.chat.completions.create({ model, messages });

expect(mock.journal.all().map((e) => e.status)).toEqual([429, 200]);

// Random, seeded faults; failures say how to replay them:
const chaotic = await createMockLLM({ seed: 2024, chaos: { rate: 0.2 } });
//   → app sees "…Overloaded [mock-llm chaos fault · seed 2024 · reproduce with MOCK_LLM_SEED=2024]"
//   $ MOCK_LLM_SEED=2024 npm test`,
    yaml: `rules:
  - when: {}
    reply: Recovered after a retry. ✅
  - when: {}
    once: true
    fail: { rateLimit: { retryAfter: 0.5 } }`,
    run: { prompt: 'Hello', maxRetries: 0 },
    variants: [
      { label: 'maxRetries: 0', run: { maxRetries: 0 }, expectError: true },
      { label: 'maxRetries: 2', run: { maxRetries: 2 } },
      {
        label: 'Chaos (seeded)',
        yaml: `default:\n  reply: Chaos let this one through.`,
        run: { maxRetries: 0, seed: 2024, chaos: { rate: 1 } },
        expectError: true,
      },
    ],
    tip: 'SDK defaults differ: OpenAI and Anthropic retry twice by default, the AWS SDK makes up to 3 attempts, and <code>@google/genai</code> only retries if you set <code>httpOptions.retryOptions</code>. The playground maps "maxRetries" onto each.',
  },
  {
    id: 'errors',
    group: 'Negative testing',
    title: 'Native errors per provider',
    intro: `
      <p>One fault produces a different, accurate failure for each provider. <code>faults.overloaded()</code> is Anthropic <code>529 overloaded_error</code>,
      OpenAI <code>503</code>, Gemini <code>503 UNAVAILABLE</code>, and Bedrock <code>ServiceUnavailableException</code>.
      Pick a fault, then switch providers and compare the error classes.</p>
      <p><b>Context window (auto)</b> uses the <code>contextWindow</code> option instead of a rule: any prompt over the model's (approximate) token limit
      gets the native context-length error with real numbers, e.g. <code>prompt is too long: 230 tokens &gt; 100 maximum</code>.</p>`,
    test: `mock.when({}).fail(faults.overloaded());
await expect(claude.messages.create(req)).rejects.toMatchObject({ status: 529 });

mock.when({}).fail(faults.contextLengthExceeded());
await expect(openai.chat.completions.create(req)).rejects.toMatchObject({ code: 'context_length_exceeded' });

// Or enforce limits for every request (approximate tokens, ~4 chars each):
// createMockLLM({ contextWindow: { 'gpt-4o': 128_000, '*': 8_000 } })`,
    yaml: `default:\n  fail: overloaded`,
    run: { prompt: 'Hello' },
    expectError: true,
    variants: [
      { label: 'overloaded', yaml: `default:\n  fail: overloaded` },
      { label: 'rateLimit', yaml: `default:\n  fail: rateLimit` },
      { label: 'authError', yaml: `default:\n  fail: authError` },
      { label: 'contextLengthExceeded', yaml: `default:\n  fail: contextLengthExceeded` },
      { label: 'serverError', yaml: `default:\n  fail: serverError` },
      { label: 'notFound', yaml: `default:\n  fail: notFound` },
      {
        label: 'Context window (auto)',
        yaml: `default:\n  reply: Never sent, because the prompt is over the context window.`,
        run: { prompt: 'Please summarise this. '.repeat(40), contextWindow: { '*': 100 } },
      },
    ],
  },
  {
    id: 'network',
    group: 'Negative testing',
    title: 'Timeouts & broken streams',
    intro: `
      <p>Real networks fail partway through. mock-llm can hang until the client gives up, reset the connection, cut a stream after <em>n</em> chunks,
      or send the provider's in-stream error event (Anthropic <code>event: error</code>, a Gemini error chunk, a Bedrock exception frame…).</p>
      <p>In the Wire tab you can see exactly where the bytes stopped.</p>`,
    test: `mock.when({}).fail(faults.timeout());
await expect(callWithTimeout(500)).rejects.toThrow(/timed out/i);

mock.when({}).fail(faults.streamCut({ afterChunks: 5 }));
mock.when({}).fail(faults.streamError({ afterChunks: 5, error: { kind: 'overloaded' } }));`,
    yaml: `default:\n  fail: { streamCut: { afterChunks: 6 } }`,
    run: { prompt: 'Hello', stream: true, timeoutMs: 800 },
    expectError: true,
    variants: [
      { label: 'Stream cut mid-way', yaml: `default:\n  fail: { streamCut: { afterChunks: 6 } }` },
      { label: 'In-stream error event', yaml: `default:\n  fail: { streamError: { afterChunks: 6 } }` },
      { label: 'Timeout (800 ms)', yaml: `default:\n  fail: timeout` },
      { label: 'Connection reset', yaml: `default:\n  fail: connectionReset`, run: { stream: false } },
    ],
  },
  {
    id: 'edge-cases',
    group: 'Negative testing',
    title: 'Awkward model output',
    intro: `
      <p>A 200 OK can still break your app. The <code>edge.*</code> helpers return realistic awkward responses: refusals, truncation at <code>max_tokens</code>,
      empty content, unicode that breaks layouts, prompt-injection text that tests your output escaping, malformed or hallucinated tool calls…</p>
      <p>The tool variants run the agent loop, so you can see how the demo app's tool runner reports bad arguments back to the model.</p>
      <p><b>Content chaos (seeded)</b> lets chaos pick the awkward behaviour instead: <code>chaos: { rate, weights: { refusal, empty, truncated, malformedToolCall } }</code>.
      It corrupts <em>your scripted reply</em> (e.g. truncates that answer), and the journal records which behaviour hit each request (<code>entry.chaos</code>).
      The same seed always produces the same sequence.</p>`,
    test: `mock.when({}).reply(edge.refusal());
mock.when({}).reply(edge.truncated(longJson));      // stop_reason: max_tokens
mock.when({}).reply(edge.promptInjection());        // <script>, SQL, {{template}} …
mock.when({}).reply(edge.malformedToolArgs('get_weather'));
mock.when({}).reply(edge.hallucinatedTool());

// Or let seeded chaos pick awkward behaviours for a fraction of requests:
// createMockLLM({ seed: 7, chaos: { rate: 0.3, weights: { refusal: 1, empty: 1, truncated: 2, malformedToolCall: 1 } } })`,
    yaml: `default:\n  edge: refusal`,
    run: { prompt: 'Help me', stream: true },
    variants: [
      { label: 'Refusal', yaml: `default:\n  edge: refusal` },
      { label: 'Truncated (max_tokens)', yaml: `default:\n  edge: { truncated: ['{"items": [{"id": 1, "name": "first"}, {"id": 2, "na'] }` },
      { label: 'Unicode chaos', yaml: `default:\n  edge: unicode` },
      { label: 'Prompt injection', yaml: `default:\n  edge: promptInjection` },
      { label: 'PII-like text', yaml: `default:\n  edge: piiLike` },
      { label: 'Empty', yaml: `default:\n  edge: empty` },
      { label: 'Malformed tool args', yaml: `rules:\n  - when: { tool: get_weather }\n    steps:\n      - edge: { malformedToolArgs: get_weather }\n      - reply: Sorry, my tool call was invalid. Retrying gave 21°C in Paris.`, run: { tools: true, agentLoop: true, stream: false } },
      { label: 'Hallucinated tool', yaml: `rules:\n  - when: { tool: get_weather }\n    steps:\n      - edge: hallucinatedTool\n      - reply: Sorry, my tool call was invalid. Retrying gave 21°C in Paris.`, run: { tools: true, agentLoop: true, stream: false } },
      {
        label: 'Content chaos (seeded)',
        yaml: `rules:\n  - when: { tool: get_weather }\n    steps:\n      - toolCall: { name: get_weather, input: { city: Paris } }\n      - reply: It is 21°C and sunny in Paris, with a light breeze.`,
        run: { tools: true, agentLoop: true, stream: false, seed: 28, chaos: { rate: 1, weights: { refusal: 1, empty: 1, truncated: 1, malformedToolCall: 1 } } }, // seed 28: a varied sequence
      },
      { label: 'Wrong arg types', yaml: `rules:\n  - when: { tool: get_weather }\n    steps:\n      - edge: { wrongToolArgTypes: get_weather }\n      - reply: Sorry, my tool call was invalid. Retrying gave 21°C in Paris.`, run: { tools: true, agentLoop: true, stream: false } },
    ],
  },
  {
    id: 'inject',
    group: 'Negative testing',
    title: 'Injecting your own text',
    intro: `
      <p>Sometimes you want a <em>normal</em> reply with something specific mixed in: a competitor's name, a forbidden word, markup.
      <code>.inject(text, { position })</code> adds text to every reply from a rule (<code>prefix</code>, <code>suffix</code> or <code>replace</code>).
      The <code>x-mock-inject</code> header does the same for a single request.</p>`,
    test: `mock.when({}).reply('Your order has shipped.').inject(' <img src=x onerror=alert(1)>');
// → "Your order has shipped. <img src=x onerror=alert(1)>"

mock.when('price').reply('It costs $10.').inject('BREAKING: ', { position: 'prefix' });`,
    yaml: `rules:
  - when: {}
    reply: Your order has shipped.
    inject: " <img src=x onerror=alert(1)>"`,
    run: { prompt: 'Where is my order?' },
  },
  {
    id: 'scenarios',
    group: 'Running tests',
    title: 'Per-request scenarios',
    intro: `
      <p>Sometimes you can't add rules, for example when driving a deployed app end-to-end or doing manual QA. Instead, send a header
      <code>x-mock-scenario: &lt;name&gt;</code>, or put <code>[[mock:&lt;name&gt;]]</code> in the prompt. No rules are loaded in this lesson at all.</p>`,
    test: `// header, set by your test harness or a proxy:
new OpenAI({ baseURL, apiKey, defaultHeaders: { 'x-mock-scenario': 'rate-limit' } });

// or straight from the UI under test:
"Summarise this document [[mock:truncated]]"

// your own named scenarios:
mock.scenario('vip').reply('Welcome back!');`,
    yaml: ``,
    run: { prompt: 'Hello', scenarioHeader: 'context-length' },
    variants: [
      { label: 'header: context-length', run: { scenarioHeader: 'context-length', prompt: 'Hello' }, expectError: true },
      { label: 'header: prompt-injection', run: { scenarioHeader: 'prompt-injection', prompt: 'Hello' } },
      { label: 'header: overloaded', run: { scenarioHeader: 'overloaded', prompt: 'Hello' }, expectError: true },
      { label: 'token: [[mock:refusal]]', run: { scenarioHeader: '', prompt: 'Write me a poem [[mock:refusal]]' } },
      { label: 'token: [[mock:unicode]]', run: { scenarioHeader: '', prompt: 'Say hi [[mock:unicode]]' } },
    ],
    showScenarioList: true,
  },
  {
    id: 'files',
    group: 'Running tests',
    title: 'Scenario files (YAML)',
    intro: `
      <p>Every lesson so far has run a scenario file. QA engineers can write and keep these without touching code, then load them with
      <code>createMockLLM({ scenarioFiles: ['support-bot.yaml'] })</code> or <code>mock.load(path)</code>.
      Unknown keys, matchers, faults and edge cases are rejected with a message naming the bad entry.</p>
      <p><strong>The YAML on the right is editable.</strong> Break it and see the validation error, or open the Playground for a blank slate.</p>
      <p>Steps can also <b>check the request they answer</b>: <code>expectToolResult</code> (what your app's tool sent back) and <code>expectRequest</code>.
      Unmet expectations don't break the app, but they fail the test, with a report naming the scenario, rule and step.
      Try the two <b>Expectation steps</b> variants and open the Assertions tab.</p>`,
    test: `const mock = await createMockLLM({ scenarioFiles: ['qa/support-bot.yaml'] });

// or merge an object at runtime
await mock.load({ rules: [{ when: { tool: 'lookup' }, fail: 'serverError' }] });`,
    yaml: `# support-bot.yaml
rules:
  - name: refund
    when: { lastUserMessage: "/refund/i" }
    reply: Refunds take 5 business days.

  - name: flaky
    when: { lastUserMessage: flaky }
    once: true
    fail: { rateLimit: { retryAfter: 0 } }

  - name: weird
    when: { lastUserMessage: weird }
    edge: unicode
    inject: " [INJECTED]"

scenarios:
  vip: { template: "Welcome back, VIP! You said: {{lastUserMessage}}" }

default:
  lorem: { tokens: 25 }`,
    editable: true,
    run: { prompt: 'I need a refund' },
    variants: [
      { label: '"I need a refund"', run: { prompt: 'I need a refund' } },
      { label: '"weird"', run: { prompt: 'something weird' } },
      { label: '"hi [[mock:vip]]"', run: { prompt: 'hi [[mock:vip]]' } },
      { label: 'Unmatched → lorem', run: { prompt: 'anything else' } },
      {
        label: 'Expectation steps: met',
        yaml: `rules:
  - name: weather-flow
    when: { tool: get_weather }
    steps:
      - toolCall: { name: get_weather, input: { city: Paris } }
      - expectToolResult: { name: get_weather, content: { conditions: sunny } }
        expectRequest: { lastUserMessage: "/weather/i" }
        reply: It is 21°C in Paris.`,
        run: { prompt: "What's the weather in Paris?", tools: true, agentLoop: true, assertions: [{ matcher: 'toHaveMetExpectations' }] },
      },
      {
        label: 'Expectation steps: not met',
        yaml: `rules:
  - name: weather-flow
    when: { tool: get_weather }
    steps:
      - toolCall: { name: get_weather, input: { city: Paris } }
      - expectToolResult: { name: get_weather, content: { conditions: rainy } }
        expectRequest: { lastUserMessage: "/weather/i" }
        reply: It is 21°C in Paris.`,
        run: { prompt: "What's the weather in Paris?", tools: true, agentLoop: true, assertions: [{ matcher: 'toHaveMetExpectations' }] },
        expectAssertionFailure: true,
      },
    ],
  },
  {
    id: 'assertions',
    group: 'Running tests',
    title: 'Asserting on what your app sent',
    intro: `
      <p>Importing <code>mock-llm/vitest</code> (or <code>mock-llm/jest</code>) registers matchers that check what your app <strong>sent</strong> to the model, the same way for every provider.
      Tools have three distinct checks: <code>toHaveOfferedTool</code> (in the request's tool list), <code>toHaveRequestedTool</code> (the mock asked for it), and
      <code>toHaveReturnedToolResult</code> (<em>your code</em> ran it and sent the result back). <code>toHaveToolTrajectory</code> checks the order your app ran tools in.</p>
      <p>Press <kbd>Run</kbd>. The demo agent runs, then the assertions below are evaluated with the real matcher code against this run's journal.
      Try <b>A failing assertion</b> to see a failure message. It includes an excerpt of every request, so you can see why without a debugger.</p>`,
    test: `import { useMockLLM } from 'mock-llm/vitest';
const mock = useMockLLM();

it('checks the weather before answering', async () => {
  mock.when({ tool: 'get_weather' })
    .replyToolCall('get_weather', { city: 'Paris' })
    .then.reply('It is 21°C and sunny in Paris.');

  await myAgent.ask("What's the weather in Paris?");

  expect(mock).toHaveReceivedRequestTimes(2);
  expect(mock).toHaveReceivedRequest({ system: 'You are a travel assistant.' });
  expect(mock).toHaveReceivedPrompt('Paris', { in: 'user' });
  expect(mock).toHaveOfferedTool('get_weather');
  expect(mock).toHaveRequestedTool('get_weather', { city: 'Paris' });
  expect(mock).toHaveReturnedToolResult('get_weather', { conditions: 'sunny' });
  expect(mock).toHaveToolTrajectory(['get_weather']);
  expect(mock).toHaveUsedTokensLessThan(2_000);
});`,
    yaml: `rules:
  - when: { tool: get_weather }
    steps:
      - toolCall: { name: get_weather, input: { city: Paris } }
      - reply: It is 21°C and sunny in Paris.`,
    run: {
      prompt: "What's the weather in Paris?",
      system: 'You are a travel assistant.',
      tools: true,
      agentLoop: true,
      assertions: [
        { matcher: 'toHaveReceivedRequestTimes', args: [2] },
        { matcher: 'toHaveReceivedRequest', args: [{ system: 'You are a travel assistant.' }] },
        { matcher: 'toHaveReceivedPrompt', args: ['Paris', { in: 'user' }] },
        { matcher: 'toHaveOfferedTool', args: ['get_weather'] },
        { matcher: 'toHaveRequestedTool', args: ['get_weather', { city: 'Paris' }] },
        { matcher: 'toHaveReturnedToolResult', args: ['get_weather', { conditions: 'sunny' }] },
        { matcher: 'toHaveToolTrajectory', args: [['get_weather']] },
        { matcher: 'toHaveUsedTokensLessThan', args: [2000] },
      ],
    },
    variants: [
      { label: 'Passing assertions' },
      {
        label: 'A failing assertion',
        expectAssertionFailure: true,
        run: {
          assertions: [
            { matcher: 'toHaveOfferedTool', args: ['get_weather'] },
            { matcher: 'toHaveToolTrajectory', args: [['get_weather', 'book_hotel']] },
            { matcher: 'toHaveOfferedTool', args: ['book_hotel'], not: true },
          ],
        },
      },
      {
        label: 'Hallucinated tool is caught',
        yaml: `rules:\n  - when: { tool: get_weather }\n    steps:\n      - edge: hallucinatedTool\n      - reply: Sorry, I could not check the weather.`,
        run: {
          assertions: [
            { matcher: 'toHaveRequestedTool', args: ['delete_all_records'] },
            { matcher: 'toHaveReturnedToolResult', args: ['delete_all_records', { regex: 'Unknown tool' }] },
            { matcher: 'toHaveReturnedToolResult', args: ['get_weather'], not: true },
          ],
        },
      },
    ],
    focusTab: 'assertions',
  },
  {
    id: 'strict',
    group: 'Running tests',
    title: 'Strict mode: no surprise LLM calls',
    intro: `
      <p>By default an unscripted request gets a canned reply. In CI you usually want the opposite: <strong>an LLM call you didn't plan for should fail the test</strong>,
      even when your app catches the error and carries on (as most well-behaved apps do).</p>
      <p>With <code>useMockLLM({ strict: true })</code>, an unmatched chat request gets the provider's native <b>400</b> (SDKs never retry it) and is flagged in the journal,
      and the test fails afterwards with an <em>UNEXPECTED LLM REQUEST</em> report that suggests the rule to add. Try <b>Unscripted request</b> and open the Assertions tab.</p>`,
    test: `import { useMockLLM } from 'mock-llm/vitest';

// Every test fails if the app makes an LLM request no rule scripted,
// even if the app swallowed the error.
const mock = useMockLLM({ strict: true });

it('answers refund questions', async () => {
  mock.when(/refund/i).reply('Refunds take 5 business days.');
  await app.ask('Where is my order?');   // ✗ unscripted → test fails:
  // UNEXPECTED LLM REQUEST: 1 request(s) matched no rule.
  //   add: mock.when({ provider: 'openai', lastUserMessage: "Where is my order?" }).reply('…');
});

// Outside Vitest, or explicitly:
mock.assertNoUnmatched();                    // throws UnmatchedRequestError
expect(mock).toHaveNoUnmatchedRequests();`,
    yaml: `rules:
  - when: { lastUserMessage: "/refund/i" }
    reply: Refunds take 5 business days.`,
    run: {
      prompt: 'Can I get a refund?',
      strict: true,
      assertions: [{ matcher: 'toHaveNoUnmatchedRequests' }],
    },
    variants: [
      { label: 'Scripted request' },
      { label: 'Unscripted request', run: { prompt: 'Where is my order?' }, expectError: true, expectAssertionFailure: true, allowUnmatched: true },
      {
        label: 'default() fallback counts as scripted',
        yaml: `rules:\n  - when: { lastUserMessage: "/refund/i" }\n    reply: Refunds take 5 business days.\ndefault:\n  reply: Let me connect you with a human.`,
        run: { prompt: 'Where is my order?' },
      },
    ],
    focusTab: 'assertions',
  },
  {
    id: 'journal',
    group: 'Running tests',
    title: 'Assertions, journal & cost',
    intro: `
      <p>Every exchange is recorded in a provider-neutral <strong>journal</strong>: the normalized request (system prompt, messages, tools), what was returned,
      status, latency, token usage, and the raw wire bytes. Assert on what your app <em>sent</em>, not only on what it displayed.</p>
      <p><code>journal.cost()</code> estimates spend using built-in Claude list prices plus any prices you pass in, so you can set budgets in CI.
      Run this two-turn agent with <b>Claude</b> or <b>Bedrock</b> to see a priced report, or with another provider to see "unpriced".</p>
      <p>To watch activity as it happens rather than afterwards, subscribe with <code>mock.on('request' | 'unmatched' | 'chunk' | 'response' | 'fault', …)</code>.
      Per request the order is always <code>request → unmatched? → chunk* → response | fault</code>. Open the <b>Events</b> tab after a run to see the timeline.</p>`,
    test: `const [first, second] = mock.journal.all();
expect(first.request.system).toContain('helpful');
expect(first.request.tools.map((t) => t.name)).toEqual(['get_weather']);
expect(second.request.messages.at(-1).content[0].type).toBe('tool_result');

expect(mock.journal.usage().inputTokens).toBeLessThan(5_000);
expect(mock.journal.cost().total).toBeLessThan(0.05);   // USD budget

// Live events, e.g. for logging or a custom reporter:
mock.on('response', ({ entry }) => console.log(entry.id, entry.status, entry.durationMs));
mock.on('fault', ({ entry, fault }) => console.warn(entry.id, fault.type));`,
    yaml: `rules:
  - when: { tool: get_weather }
    steps:
      - toolCall: { name: get_weather, input: { city: Paris } }
      - reply: It is 21°C and sunny in Paris.
        usage: { inputTokens: 1200, outputTokens: 300 }`,
    run: { prompt: "What's the weather in Paris?", system: 'You are a helpful travel assistant.', tools: true, agentLoop: true },
    defaultProvider: 'anthropic',
    focusTab: 'journal',
  },
  {
    id: 'playwright',
    group: 'Running tests',
    title: 'Playwright: full-stack browser tests',
    static: true,
    intro: `
      <p><code>mock-llm/playwright</code> runs <strong>one shared mock</strong> for the whole run. <code>globalSetup</code> starts it,
      your app server gets <code>mockLLMEnv(port)</code> through <code>webServer.env</code>, and each test scripts it over HTTP through the <code>llm</code> fixture.
      Because the mock is in another process, scripting uses the scenario-file format (<code>llm.load({...})</code>), and the matchers are async (<code>await expect(llm)…</code>).</p>
      <p>There are two safety nets. <code>blockRealProviders</code> (on by default) fails a test whose <em>browser</em> calls a real provider API; use
      <code>llm.routeBrowser(page)</code> to send those calls to the mock instead. <code>llmStrict</code> fails a test that made an unscripted LLM request,
      even if the UI showed a friendly error. Use <code>workers: 1</code>: parallel workers would share one mock's rules and journal.</p>
      <p>The full, runnable setup is <code>examples/playwright-chat-ui</code> (Chromium, 7 tests, including two deliberate failures that prove both safety nets).</p>`,
    test: `// playwright.config.mjs
export default defineConfig({
  workers: 1,
  globalSetup: './tests/global-setup.mjs',      // export default () => startMockLLM({ port: 4010, strict: true })
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4321', env: { ...mockLLMEnv(4010), PORT: '4321' } },
  use: { baseURL: 'http://127.0.0.1:4321', llmStrict: true },
});

// tests/chat.spec.mjs
import { test, expect } from 'mock-llm/playwright';

test('answers an order question using the lookup tool', async ({ page, llm }) => {
  await llm.load({
    rules: [
      { when: { tool: 'lookup_order', hasToolResult: false }, toolCall: { name: 'lookup_order', input: { order_id: 'A-1001' } } },
      { when: { hasToolResult: true }, reply: 'Your order A-1001 has shipped.' },
    ],
  });

  await page.goto('/');
  await page.getByLabel('Message').fill('Where is order A-1001?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Your order A-1001 has shipped.')).toBeVisible();

  await expect(llm).toHaveToolTrajectory(['lookup_order']);
  await expect(llm).toHaveReturnedToolResult('lookup_order', { status: 'shipped' });
});

test('bring-your-own-key: the browser calls OpenAI directly', async ({ page, llm }) => {
  await llm.routeBrowser(page);   // without this, blockRealProviders fails the test
  // …
});`,
  },
  {
    id: 'env',
    group: 'Running tests',
    title: 'Any process: env vars & Claude Code',
    static: true,
    intro: `
      <p>The mock is a real HTTP server, so it works for <strong>anything that can make a request</strong>: a service started in a child process, a Python
      worker, a CLI, or Claude Code itself. <code>mock.env()</code> returns the variables each SDK reads, so <code>new OpenAI()</code>,
      <code>new Anthropic()</code>, <code>new GoogleGenAI({})</code> and <code>new BedrockRuntimeClient({})</code> need no code changes.</p>
      <p>Out-of-process tests can read <code>GET /__mock/journal</code> and call <code>POST /__mock/reset</code>.</p>
      <p>Working starters are in the repo's <code>examples/</code> folder. <code>node-service-e2e</code> runs a real service this way, and
      <code>claude-code-cli</code> runs the actual Claude Code CLI against the mock.</p>`,
    test: `const mock = await createMockLLM();
mock.default().reply('Hello from mock-llm! No tokens were spent.');

// Run the real Claude Code CLI against the mock
spawn('claude', ['-p', 'say hi'], { env: { ...process.env, ...mock.env() } });

// mock.env() →
// OPENAI_BASE_URL                   http://127.0.0.1:PORT/openai/v1
// ANTHROPIC_BASE_URL                http://127.0.0.1:PORT/anthropic
// GOOGLE_GEMINI_BASE_URL            http://127.0.0.1:PORT/gemini
// AWS_ENDPOINT_URL_BEDROCK_RUNTIME  http://127.0.0.1:PORT/bedrock
// + dummy API keys / AWS credentials / AWS_REGION`,
  },
];
