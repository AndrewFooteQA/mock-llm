import { Rng } from './rng.js';

export interface FakeOptions {
  /** Produce a value that violates the schema (missing required field / wrong type). */
  violate?: boolean;
  /** Seed for the generated value (default 1): the same seed and schema always give the same value. */
  seed?: number;
}

/**
 * Generate a deterministic value conforming to a JSON Schema (and Gemini's
 * OpenAPI-style subset, e.g. `type: "OBJECT"`). Supports the subset structured
 * outputs and tool schemas use in practice: object/array/scalars, enum, const,
 * required, anyOf/oneOf/allOf, local $ref, formats, numeric/length bounds.
 */
export function fakeFromSchema(schema: unknown, opts?: FakeOptions): unknown;
/** With an explicit random source (how the rule engine calls it, sharing the mock's seeded stream). */
export function fakeFromSchema(schema: unknown, rng: Rng, opts?: FakeOptions): unknown;
export function fakeFromSchema(schema: unknown, rngOrOpts: Rng | FakeOptions = {}, maybeOpts: FakeOptions = {}): unknown {
  const isRng = rngOrOpts instanceof Rng;
  const opts = isRng ? maybeOpts : rngOrOpts;
  const rng = isRng ? rngOrOpts : new Rng(opts.seed ?? 1);
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
    const all = s.anyOf ?? s.oneOf;
    const options = all.filter((o: any) => typeOf(resolve(o, root)) !== 'null');
    return gen(options[0] ?? all[0] ?? {}, root, rng, depth, key);
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
      const min = s.minItems ?? Math.min(1, s.maxItems ?? 1);
      const max = Math.max(min, Math.min(s.maxItems ?? 3, min + 2));
      const n = min + rng.int(max - min + 1);
      return Array.from({ length: n }, () => gen(s.items ?? {}, root, rng, depth + 1, key));
    }
    case 'integer':
    case 'number':
      return fakeNumber(s, rng, typeOf(s) === 'integer');
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

/** A number inside the schema's bounds (draft-04 boolean and draft-06+ numeric exclusive bounds). */
function fakeNumber(s: any, rng: Rng, integer: boolean): number {
  let lo = typeof s.minimum === 'number' ? s.minimum : -Infinity;
  let hi = typeof s.maximum === 'number' ? s.maximum : Infinity;
  let loOpen = s.exclusiveMinimum === true;
  let hiOpen = s.exclusiveMaximum === true;
  if (typeof s.exclusiveMinimum === 'number' && s.exclusiveMinimum >= lo) [lo, loOpen] = [s.exclusiveMinimum, true];
  if (typeof s.exclusiveMaximum === 'number' && s.exclusiveMaximum <= hi) [hi, hiOpen] = [s.exclusiveMaximum, true];
  // Unbounded sides default to a 0..100 range next to whatever bound is given.
  if (lo === -Infinity) lo = hi >= 0 ? 0 : hi - 100;
  if (hi === Infinity) hi = lo + 100;
  const v = lo + rng.next() * (hi - lo);
  if (integer) {
    const min = loOpen ? Math.floor(lo) + 1 : Math.ceil(lo);
    const max = hiOpen ? Math.ceil(hi) - 1 : Math.floor(hi);
    return min > max ? min : Math.min(max, Math.max(min, Math.round(v))); // min > max: unsatisfiable, best effort
  }
  const inside = (x: number) => (loOpen ? x > lo : x >= lo) && (hiOpen ? x < hi : x <= hi);
  const rounded = Math.round(v * 100) / 100;
  if (inside(rounded)) return rounded;
  return inside(v) ? v : (lo + hi) / 2;
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

/**
 * Break a conforming value so it really fails validation: drop the first required property, else give a typed
 * property the wrong type, else (no required or typed properties) return a non-object.
 */
function violate(s0: any, value: unknown, root: any): unknown {
  const s = resolve(s0, root);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = { ...(value as Record<string, unknown>) };
    const typeOfProp = (k: string) => typeOf(resolve(s.properties?.[k] ?? {}, root));
    const req: string[] = (s.required ?? []).filter((k: string) => k in obj);
    // Wrong type is more interesting than a missing key when there's only one required field.
    if (req.length > 1 || (req.length === 1 && typeOfProp(req[0]!) === undefined)) {
      delete obj[req[0]!];
      return obj;
    }
    const k = req[0] ?? Object.keys(obj).find((key) => typeOfProp(key) !== undefined);
    if (k === undefined) return 'not-an-object';
    const t = typeOfProp(k)!;
    obj[k] = t === 'string' ? 12345 : 'not-a-' + t;
    return obj;
  }
  if (Array.isArray(value)) return 'not-an-array';
  return typeof value === 'string' ? 12345 : 'not-a-' + typeof value;
}
