/**
 * Model catalogue entries for the `models` option. A plain id is an active model with every capability; a
 * `ModelSpec` can mark a model deprecated or retired and narrow its capabilities. Lifecycle and capabilities are
 * Anthropic Models API concepts (API version 2026-10-21): the OpenAI and Gemini models endpoints list only the ids.
 */

/** Support flag used throughout the Anthropic `capabilities` object. */
export interface CapabilitySupport {
  supported: boolean;
}

/** The Anthropic Models API `capabilities` object (SDK ≥ 1.0 `ModelCapabilities`). Every key is always present. */
export interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  context_management: {
    clear_thinking_20251015: CapabilitySupport | null;
    clear_tool_uses_20250919: CapabilitySupport | null;
    compact_20260112: CapabilitySupport | null;
    supported: boolean;
  };
  effort: {
    high: CapabilitySupport;
    low: CapabilitySupport;
    max: CapabilitySupport;
    medium: CapabilitySupport;
    supported: boolean;
    xhigh: CapabilitySupport | null;
  };
  image_input: CapabilitySupport;
  pdf_input: CapabilitySupport;
  server_tools: { code_execution: CapabilitySupport; supported: boolean; web_search: CapabilitySupport };
  structured_outputs: CapabilitySupport;
  thinking: {
    supported: boolean;
    types: { adaptive: CapabilitySupport; between_tools: CapabilitySupport; disabled: CapabilitySupport; enabled: CapabilitySupport };
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | Extract<T[K], null> : T[K] };

/** Anthropic model lifecycle stage. */
export type ModelLifecycle = 'active' | 'deprecated' | 'retired';

/** One entry of the `models` option, for when a plain id isn't enough. */
export interface ModelSpec {
  id: string;
  /** Display name on the Anthropic models endpoints. Defaults to the id. */
  displayName?: string;
  /**
   * Anthropic lifecycle stage (default `'active'`). `models.list()` hides `retired` models unless the request's
   * `lifecycle` filter asks for them, as the API does. A Messages request naming a `retired` model gets a 404
   * `not_found_error`: Anthropic documents only that such requests fail, so this error shape is **unverified**.
   */
  lifecycle?: ModelLifecycle;
  /** RFC 3339 time of the deprecation. Defaults to `2025-01-01T00:00:00Z` for deprecated and retired models, else `null`. */
  deprecatedAt?: string;
  /** RFC 3339 scheduled retirement. Defaults to `null`. */
  retiresAt?: string;
  /** Anthropic model line (`'opus'`, `'sonnet'`, …), or `null`. Defaults to the line in a first-party Claude id. */
  line?: string | null;
  /**
   * Anthropic `capabilities`, merged over "everything supported". A thinking type marked unsupported
   * (`{ thinking: { types: { disabled: { supported: false } } } }`) makes Messages requests that send it fail with the
   * API's documented 400 `invalid_request_error`.
   */
  capabilities?: DeepPartial<ModelCapabilities>;
}

const yes = (): CapabilitySupport => ({ supported: true });

/** Every capability supported: the default for a model the `models` option doesn't narrow. */
export function defaultCapabilities(): ModelCapabilities {
  return {
    batch: yes(),
    citations: yes(),
    code_execution: yes(),
    context_management: { clear_thinking_20251015: yes(), clear_tool_uses_20250919: yes(), compact_20260112: yes(), supported: true },
    effort: { high: yes(), low: yes(), max: yes(), medium: yes(), supported: true, xhigh: yes() },
    image_input: yes(),
    pdf_input: yes(),
    server_tools: { code_execution: yes(), supported: true, web_search: yes() },
    structured_outputs: yes(),
    thinking: { supported: true, types: { adaptive: yes(), between_tools: yes(), disabled: yes(), enabled: yes() } },
  };
}

function merge(base: any, over: any): any {
  if (over === undefined) return base;
  if (over === null || typeof over !== 'object' || Array.isArray(over) || base === null || typeof base !== 'object') return over;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

/** A model's capabilities: the spec's partial `capabilities` merged over `defaultCapabilities()`. */
export function capabilitiesOf(spec: ModelSpec | undefined): ModelCapabilities {
  return merge(defaultCapabilities(), spec?.capabilities);
}

/** Normalize the `models` option: ids in order, plus the specs by id. Throws on a malformed entry. */
export function normalizeModels(models: Array<string | ModelSpec>): { ids: string[]; specs: Map<string, ModelSpec> } {
  const ids: string[] = [];
  const specs = new Map<string, ModelSpec>();
  for (const m of models) {
    const spec: ModelSpec = typeof m === 'string' ? { id: m } : m;
    if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error(`mock-llm: invalid models entry ${JSON.stringify(m)}: expected an id or { id, … }`);
    if (spec.lifecycle !== undefined && !['active', 'deprecated', 'retired'].includes(spec.lifecycle)) {
      throw new Error(`mock-llm: models entry "${spec.id}": lifecycle must be 'active', 'deprecated' or 'retired', got ${JSON.stringify(spec.lifecycle)}`);
    }
    for (const key of ['deprecatedAt', 'retiresAt'] as const) {
      const v = spec[key];
      if (v !== undefined && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) {
        throw new Error(`mock-llm: models entry "${spec.id}": ${key} must be an RFC 3339 date-time string, got ${JSON.stringify(v)}`);
      }
    }
    ids.push(spec.id);
    specs.set(spec.id, spec);
  }
  return { ids, specs };
}
