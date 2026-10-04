import type { Rng } from './rng.js';

export interface FakeOptions {
  /** Produce a value that violates the schema (missing required field / wrong type). */
  violate?: boolean;
}

/**
 * Generate a deterministic value conforming to a JSON Schema (and Gemini's
 * OpenAPI-style subset, e.g. `type: "OBJECT"`). Supports the subset structured
 * outputs and tool schemas use in practice: object/array/scalars, enum, const,
 * required, anyOf/oneOf/allOf, local $ref, formats, numeric/length bounds.
 */
export function fakeFromSchema(schema: unknown, rng: Rng, opts: FakeOptions = {}): unknown {
  const root = (schema ?? {}) as Record<string, any>;
  const value = gen(root, root, rng, 0, 'value');
  return opts.violate ? violate(root, value, root) : value;
}

function resolve(s: any, root: any): any {
  let cur = s;
  for (let i = 0; cur?.$ref && i < 20; i++) {
    const path = String(cur.$ref).replace(/^#\/?/, '').split('/').filter(Boolean);
    cur = path.reduce((o: any, k) => o?.[decodeURIComponent(k.replace(/~1/g, '/').replace(/~0/g, '~'))], root);
  }
  return cur ?? {};
}

function typeOf(s: any): string | undefined {
  let t = s.type;
  if (Array.isArray(t)) t = t.find((x: string) => x !== 'null') ?? t[0];
  if (typeof t === 'string') return t.toLowerCase();
  if (s.properties) return 'object';
  if (s.items) return 'array';
  return undefined;
}

function gen(s0: any, root: any, rng: Rng, depth: number, key: string): unknown {
  const s = resolve(s0, root);
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[rng.int(s.enum.length)];
  if (Array.isArray(s.anyOf ?? s.oneOf)) {
    const options = (s.anyOf ?? s.oneOf).filter((o: any) => typeOf(resolve(o, root)) !== 'null');
    return gen(options[0] ?? {}, root, rng, depth, key);
  }
  if (Array.isArray(s.allOf)) {
    const merged = s.allOf.map((o: any) => resolve(o, root)).reduce(
      (a: any, b: any) => ({ ...a, ...b, properties: { ...a.properties, ...b.properties }, required: [...(a.required ?? []), ...(b.required ?? [])] }),
      {},
    );
    return gen(merged, root, rng, depth, key);
  }
  switch (typeOf(s)) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = s.properties ?? {};
      if (depth > 6) return out;
      for (const [k, v] of Object.entries(props)) out[k] = gen(v, root, rng, depth + 1, k);
      return out;
    }
    case 'array': {
      if (depth > 6) return [];
      const min = s.minItems ?? 1;
      const max = Math.max(min, Math.min(s.maxItems ?? 3, min + 2));
      const n = min + rng.int(max - min + 1);
      return Array.from({ length: n }, () => gen(s.items ?? {}, root, rng, depth + 1, key));
    }
    case 'integer':
    case 'number': {
      const min = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 0);
      const max = s.maximum ?? (s.exclusiveMaximum !== undefined ? s.exclusiveMaximum - 1 : min + 100);
      const v = min + rng.next() * (max - min);
      return typeOf(s) === 'integer' ? Math.round(v) : Math.round(v * 100) / 100;
    }
    case 'boolean':
      return rng.next() < 0.5;
    case 'null':
      return null;
    case 'string':
      return fakeString(s, rng, key);
    default:
      return fakeString({}, rng, key);
  }
}

function fakeString(s: any, rng: Rng, key: string): string {
  switch (s.format) {
    case 'email':
      return `user${rng.int(1000)}@example.com`;
    case 'date-time':
      return new Date(Date.UTC(2026, rng.int(12), 1 + rng.int(28), rng.int(24), rng.int(60))).toISOString();
    case 'date':
      return `2026-${String(1 + rng.int(12)).padStart(2, '0')}-${String(1 + rng.int(28)).padStart(2, '0')}`;
    case 'uuid': {
      const h = () => rng.int(16).toString(16);
      const part = (n: number) => Array.from({ length: n }, h).join('');
      return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
    }
    case 'uri':
    case 'url':
      return `https://example.com/${key}/${rng.int(1000)}`;
  }
  let out = `${key}_${rng.id(6).toLowerCase()}`;
  if (s.minLength && out.length < s.minLength) out = out.padEnd(s.minLength, 'x');
  if (s.maxLength && out.length > s.maxLength) out = out.slice(0, s.maxLength);
  return out;
}

/** Break a conforming value: drop the first required property, else flip a type. */
function violate(s0: any, value: unknown, root: any): unknown {
  const s = resolve(s0, root);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = { ...(value as Record<string, unknown>) };
    const req: string[] = s.required ?? Object.keys(obj);
    if (req[0] !== undefined) {
      const k = req[0];
      const t = typeOf(resolve(s.properties?.[k] ?? {}, root));
      // Wrong type is more interesting than a missing key when there's only one field.
      if (req.length > 1 || t === undefined) delete obj[k];
      else obj[k] = t === 'string' ? 12345 : 'not-a-' + t;
    }
    return obj;
  }
  if (Array.isArray(value)) return 'not-an-array';
  return typeof value === 'string' ? 12345 : 'not-a-' + typeof value;
}
