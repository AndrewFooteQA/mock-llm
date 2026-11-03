import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, InvokeModelCommand, ValidationException } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import type { ModelSpec } from '../../src/index.js';
import { useMockLLM } from '../../src/testing/vitest.js';
import { sdkAtLeast } from '../helpers/sdk-version.js';

// ROADMAP R22: API version 2026-10-21 behaviour (SDK 1.x), checked through the official SDK.
// Sources: platform.claude.com/docs/en/build-with-claude/thinking (per-model table, progress updates),
// /api/errors (exact 400 messages), /api/models/list (lifecycle filter default), SDK 1.4.0 models.d.ts.

const SONNET_55_LIKE: ModelSpec = {
  id: 'claude-sonnet-5-5',
  capabilities: { thinking: { types: { disabled: { supported: false }, enabled: { supported: false } } } },
};
const OPUS_55_LIKE: ModelSpec = {
  id: 'claude-opus-5-5',
  capabilities: { thinking: { types: { disabled: { supported: false }, between_tools: { supported: false }, enabled: { supported: false } } } },
};
const MODELS: Array<string | ModelSpec> = [
  OPUS_55_LIKE,
  SONNET_55_LIKE,
  { id: 'claude-mythos-preview', lifecycle: 'deprecated', retiresAt: '2027-01-15T00:00:00Z', capabilities: { thinking: { types: { disabled: { supported: false }, between_tools: { supported: false } } } } },
  { id: 'claude-sonnet-4-5-20250929', lifecycle: 'deprecated', deprecatedAt: '2026-09-30T00:00:00Z', retiresAt: '2026-11-30T00:00:00Z' },
  { id: 'claude-3-7-sonnet-20250219', lifecycle: 'retired', deprecatedAt: '2025-10-28T00:00:00Z', retiresAt: '2026-02-19T00:00:00Z' },
  'claude-haiku-5-5',
  { ...SONNET_55_LIKE, id: 'us.anthropic.claude-sonnet-5-5' },
];

const mock = useMockLLM({ seed: 3, models: MODELS });
const client = () => new Anthropic({ baseURL: mock.urls.anthropic, apiKey: 'test', maxRetries: 0 });
type Params = Anthropic.MessageCreateParamsNonStreaming;
const ask = (model: string, extra: Partial<Params> = {}) =>
  client().messages.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'Where is order A-1?' }], ...extra } as Params);
const tools: Anthropic.Tool[] = [{ name: 'lookup_order', input_schema: { type: 'object', properties: { id: { type: 'string' } } } }];
const types = (m: Anthropic.Message) => m.content.map((c) => c.type);

describe('thinking: disabled and between_tools shape the reply', () => {
  it('disabled: scripted thinking is left out (non-streaming and streaming)', async () => {
    mock.when({}).reply('Shipped.', { thinking: 'Let me check.' });
    expect(types(await ask('claude-haiku-5-5', { thinking: { type: 'disabled' } }))).toEqual(['text']);
    const streamed = await client()
      .messages.stream({ model: 'claude-haiku-5-5', max_tokens: 64, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'q' }] })
      .finalMessage();
    expect(types(streamed)).toEqual(['text']);
  });

  it('between_tools: no tool call, so text only (no up-front thinking)', async () => {
    mock.when({}).reply('Shipped.', { thinking: 'Let me check.' });
    expect(types(await ask('claude-sonnet-5-5', { thinking: { type: 'between_tools' } }))).toEqual(['text']);
  });

  it('between_tools: the thinking block comes back as the progress update right before the tool call', async () => {
    mock.when({}).replyToolCall('lookup_order', { id: 'A-1' }, { thinking: 'Looking up A-1.', text: 'One moment.' });
    const r = await ask('claude-sonnet-5-5', { thinking: { type: 'between_tools' }, tools });
    expect(types(r)).toEqual(['text', 'thinking', 'tool_use']);
    expect(r.content[1]).toMatchObject({ type: 'thinking', thinking: 'Looking up A-1.' });
    expect((r.content[1] as Anthropic.ThinkingBlock).signature).toBeTruthy();

    const streamed = await client()
      .messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 64, thinking: { type: 'between_tools' }, tools, messages: [{ role: 'user', content: 'q' }] })
      .finalMessage();
    expect(types(streamed)).toEqual(['text', 'thinking', 'tool_use']);
  });

  it('adaptive (or no thinking field): the reply is unchanged', async () => {
    mock.when({}).reply('Shipped.', { thinking: 'Let me check.' });
    expect(types(await ask('claude-sonnet-5-5', { thinking: { type: 'adaptive' } }))).toEqual(['thinking', 'text']);
    expect(types(await ask('claude-sonnet-5-5'))).toEqual(['thinking', 'text']);
  });

  it('the journal records what was sent, so usage matches the reply', async () => {
    mock.when({}).reply('Shipped.', { thinking: 'A long chain of thought that is not sent.' });
    await ask('claude-haiku-5-5', { thinking: { type: 'disabled' } });
    expect(mock.journal.last()!.response!.content.map((c) => c.type)).toEqual(['text']);
  });
});

describe('thinking: rejections follow the model capabilities (documented 400 messages)', () => {
  const rejects = async (model: string, thinking: object) => {
    mock.when({}).reply('should not be sent');
    const err = await ask(model, { thinking } as Partial<Params>).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err.status).toBe(400);
    expect(err.error?.error?.type).toBe('invalid_request_error');
    return err.error.error.message as string;
  };

  it('disabled on a model that offers between_tools instead (Claude Sonnet 5.5)', async () => {
    expect(await rejects('claude-sonnet-5-5', { type: 'disabled' })).toBe(
      'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}. The model does not think before responding. The short updates it writes between tool calls come back as thinking blocks.',
    );
  });

  it('disabled where thinking is always on (Claude Opus 5.5) and where extended thinking is the way (Mythos Preview)', async () => {
    expect(await rejects('claude-opus-5-5', { type: 'disabled' })).toBe(
      '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
    );
    expect(await rejects('claude-mythos-preview', { type: 'disabled' })).toBe(
      '"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode when not specified; use "thinking.type.enabled" with "budget_tokens" for extended thinking.',
    );
  });

  it('between_tools and enabled where the model rejects them', async () => {
    expect(await rejects('claude-opus-5-5', { type: 'between_tools' })).toBe('"thinking.type.between_tools" is not supported for this model.');
    expect(await rejects('claude-opus-5-5', { type: 'enabled', budget_tokens: 2048 })).toBe(
      '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
    );
  });

  it('model-independent: between_tools takes no other field; display is invalid with disabled; unknown types', async () => {
    expect(await rejects('claude-haiku-5-5', { type: 'between_tools', display: 'summarized' })).toMatch(/^thinking\.display: /);
    expect(await rejects('claude-haiku-5-5', { type: 'disabled', display: 'omitted' })).toMatch(/^thinking\.display: /);
    expect(await rejects('claude-haiku-5-5', { type: 'sometimes' })).toMatch(/^thinking\.type: /);
  });

  it('a model the models option does not narrow accepts every type', async () => {
    mock.when({}).reply('ok');
    for (const type of ['disabled', 'between_tools', 'adaptive'] as const) {
      expect((await ask('claude-haiku-5-5', { thinking: { type } })).content[0]).toMatchObject({ type: 'text', text: 'ok' });
    }
  });

  it('is recorded as a validation error, not a fault, and never reaches the rules', async () => {
    mock.when({}).reply('should not be sent');
    await ask('claude-sonnet-5-5', { thinking: { type: 'disabled' } }).catch(() => {});
    const e = mock.journal.last()!;
    expect(e.status).toBe(400);
    expect(e.fault).toBeUndefined();
    expect(e.response).toBeUndefined();
  });
});

describe('fast mode: the speed matcher', () => {
  it('routes on speed; a request without it counts as standard', async () => {
    mock.when({ speed: 'standard' }).reply('standard lane');
    mock.when({ speed: 'fast' }).reply('fast lane');
    const fast = await ask('claude-opus-5-5', { speed: 'fast' } as Partial<Params>);
    expect(fast.content[0]).toMatchObject({ text: 'fast lane' });
    expect(fast.usage.speed).toBe('fast');
    expect((await ask('claude-opus-5-5')).content[0]).toMatchObject({ text: 'standard lane' });
  });

  it('is recorded in the journal and assertable', async () => {
    mock.when({}).reply('ok');
    await ask('claude-opus-5-5', { speed: 'fast' } as Partial<Params>);
    expect(mock.journal.last()!.request.speed).toBe('fast');
    expect(mock).toHaveReceivedRequest({ speed: 'fast' });
    await ask('claude-opus-5-5');
    expect(mock.journal.last()!.request.speed).toBeUndefined();
  });
});

describe('models: lifecycle and capabilities', () => {
  const list = async (params?: object) => {
    const out: Anthropic.ModelInfo[] = [];
    for await (const m of client().models.list(params as Anthropic.ModelListParams)) out.push(m);
    return out;
  };

  it('lists active and deprecated models by default, never retired ones', async () => {
    const ids = (await list()).map((m) => m.id);
    expect(ids).toContain('claude-sonnet-4-5-20250929');
    expect(ids).not.toContain('claude-3-7-sonnet-20250219');
    expect(ids).toEqual(MODELS.map((m) => (typeof m === 'string' ? m : m.id)).filter((id) => id !== 'claude-3-7-sonnet-20250219'));
  });

  it.runIf(sdkAtLeast('@anthropic-ai/sdk', '1.0.0'))('honours the lifecycle filter (SDK ≥ 1.0 sends lifecycle[]=…)', async () => {
    expect((await list({ lifecycle: ['retired'] })).map((m) => m.id)).toEqual(['claude-3-7-sonnet-20250219']);
    expect((await list({ lifecycle: ['deprecated', 'retired'] })).map((m) => m.lifecycle)).toEqual(['deprecated', 'deprecated', 'retired']);
    const err = await list({ lifecycle: ['archived'] }).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
  });

  it('model objects carry lifecycle, dates and line from the ModelSpec', async () => {
    const m = await client().models.retrieve('claude-sonnet-4-5-20250929');
    expect(m).toMatchObject({ lifecycle: 'deprecated', deprecated_at: '2026-09-30T00:00:00Z', retires_at: '2026-11-30T00:00:00Z', line: 'sonnet' });
    expect(await client().models.retrieve('claude-mythos-preview')).toMatchObject({ lifecycle: 'deprecated', deprecated_at: '2025-01-01T00:00:00Z', line: 'mythos' });
    expect(await client().models.retrieve('claude-haiku-5-5')).toMatchObject({ lifecycle: 'active', deprecated_at: null, retires_at: null });
  });

  it('a retired model stays retrievable (the catalogue keeps it)', async () => {
    expect(await client().models.retrieve('claude-3-7-sonnet-20250219')).toMatchObject({ lifecycle: 'retired', retires_at: '2026-02-19T00:00:00Z' });
  });

  it('capabilities: every key present; the ModelSpec narrows them', async () => {
    const haiku = await client().models.retrieve('claude-haiku-5-5');
    expect(Object.keys(haiku.capabilities!).sort()).toEqual(
      ['batch', 'citations', 'code_execution', 'context_management', 'effort', 'image_input', 'pdf_input', 'server_tools', 'structured_outputs', 'thinking'],
    );
    expect(haiku.capabilities!.thinking.types).toEqual({
      adaptive: { supported: true },
      between_tools: { supported: true },
      disabled: { supported: true },
      enabled: { supported: true },
    });
    const sonnet = await client().models.retrieve('claude-sonnet-5-5');
    expect(sonnet.capabilities!.thinking.types).toMatchObject({ disabled: { supported: false }, between_tools: { supported: true } });
    expect(sonnet.capabilities!.effort.xhigh).toEqual({ supported: true });
  });

  it('a Messages request naming a retired model fails with 404 not_found_error (unverified shape, see ModelSpec)', async () => {
    mock.when({}).reply('should not be sent');
    const err = await ask('claude-3-7-sonnet-20250219').catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.NotFoundError);
    expect(err.error?.error).toMatchObject({ type: 'not_found_error', message: 'model: claude-3-7-sonnet-20250219' });
  });

  it('a deprecated model still answers', async () => {
    mock.when({}).reply('still here');
    expect((await ask('claude-sonnet-4-5-20250929')).content[0]).toMatchObject({ text: 'still here' });
  });
});

describe('Bedrock InvokeModel (Claude body): the same thinking config', () => {
  const bedrock = () =>
    new BedrockRuntimeClient({ endpoint: mock.urls.bedrock, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  const invoke = (thinking: object, tools?: unknown[]) =>
    bedrock()
      .send(
        new InvokeModelCommand({
          modelId: 'us.anthropic.claude-sonnet-5-5',
          contentType: 'application/json',
          body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, thinking, tools, messages: [{ role: 'user', content: 'q' }] }),
        }),
      )
      .then((r) => JSON.parse(new TextDecoder().decode(r.body)));

  it('between_tools: progress update before the tool call, no up-front thinking', async () => {
    mock.when({}).replyToolCall('lookup_order', { id: 'A-1' }, { thinking: 'Looking up A-1.' });
    const r = await invoke({ type: 'between_tools' }, [{ name: 'lookup_order', input_schema: { type: 'object' } }]);
    expect(r.content.map((c: { type: string }) => c.type)).toEqual(['thinking', 'tool_use']);
    mock.when({}).reply('Shipped.', { thinking: 'Let me check.' });
    expect((await invoke({ type: 'between_tools' })).content.map((c: { type: string }) => c.type)).toEqual(['text']);
  });

  it("a type the model rejects is a ValidationException, Bedrock's 400 equivalent", async () => {
    mock.when({}).reply('should not be sent');
    await expect(invoke({ type: 'disabled' })).rejects.toBeInstanceOf(ValidationException);
  });
});
