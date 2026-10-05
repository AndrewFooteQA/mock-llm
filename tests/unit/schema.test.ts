import { describe, expect, it } from 'vitest';
import { fakeFromSchema } from '../../src/index.js';
import { Rng } from '../../src/core/rng.js';

/** Values for seeds 1..n, so a bound that only fails for some draws still gets caught. */
const sample = (schema: unknown, n = 200) => Array.from({ length: n }, (_, i) => fakeFromSchema(schema, new Rng(i + 1)));

describe('fakeFromSchema: numeric bounds', () => {
  it('a maximum below zero is respected (the minimum no longer defaults to 0)', () => {
    for (const v of sample({ type: 'integer', maximum: -5 }) as number[]) expect(v).toBeLessThanOrEqual(-5);
    for (const v of sample({ type: 'number', maximum: -0.5 }) as number[]) expect(v).toBeLessThanOrEqual(-0.5);
  });

  it('draft-06+ numeric exclusive bounds are open', () => {
    for (const v of sample({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }) as number[]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    for (const v of sample({ type: 'integer', exclusiveMinimum: 2, exclusiveMaximum: 5 }) as number[]) expect([3, 4]).toContain(v);
  });

  it('draft-04 boolean exclusiveMinimum / exclusiveMaximum modify minimum / maximum', () => {
    for (const v of sample({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 1, exclusiveMaximum: true }) as number[]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    for (const v of sample({ type: 'integer', minimum: 1, exclusiveMinimum: true, maximum: 3 }) as number[]) expect([2, 3]).toContain(v);
  });

  it('integers stay inside fractional bounds, and 2-decimal rounding never escapes a tight range', () => {
    for (const v of sample({ type: 'integer', minimum: 0.5, maximum: 2.5 }) as number[]) expect([1, 2]).toContain(v);
    for (const v of sample({ type: 'number', minimum: 0.001, maximum: 0.002 }) as number[]) {
      expect(v).toBeGreaterThanOrEqual(0.001);
      expect(v).toBeLessThanOrEqual(0.002);
    }
  });

  it('default ranges are unchanged (0..100, or minimum..minimum+100)', () => {
    for (const v of sample({ type: 'integer' }) as number[]) expect(v >= 0 && v <= 100).toBe(true);
    for (const v of sample({ type: 'number', minimum: -500 }) as number[]) expect(v >= -500 && v <= -400).toBe(true);
    expect(fakeFromSchema({ type: 'integer', minimum: 5, maximum: 9 }, new Rng(3))).toBe(fakeFromSchema({ type: 'integer', minimum: 5, maximum: 9 }, new Rng(3)));
  });
});

describe('fakeFromSchema: arrays and anyOf', () => {
  it('maxItems: 0 gives an empty array', () => {
    for (const v of sample({ type: 'array', items: { type: 'string' }, maxItems: 0 }, 20)) expect(v).toEqual([]);
  });

  it('anyOf / oneOf with only a null option gives null', () => {
    expect(fakeFromSchema({ anyOf: [{ type: 'null' }] }, new Rng(1))).toBeNull();
    expect(fakeFromSchema({ oneOf: [{ type: 'null' }] }, new Rng(1))).toBeNull();
    // A non-null option is still preferred.
    expect(typeof fakeFromSchema({ anyOf: [{ type: 'null' }, { type: 'string' }] }, new Rng(1))).toBe('string');
  });
});

describe('fakeFromSchema({ violate: true }) always breaks the schema', () => {
  it('no required list: a typed property gets the wrong type (dropping an optional key would still be valid)', () => {
    const v = fakeFromSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } }, new Rng(1), { violate: true }) as any;
    expect(v.a).toBe(12345);
    expect(typeof v.b).toBe('number');
  });

  it('required: [] is treated like no required list', () => {
    const v = fakeFromSchema({ type: 'object', properties: { n: { type: 'number' } }, required: [] }, new Rng(1), { violate: true }) as any;
    expect(v.n).toBe('not-a-number');
  });

  it('an object with no (typed) properties becomes a non-object', () => {
    expect(fakeFromSchema({ type: 'object' }, new Rng(1), { violate: true })).toBe('not-an-object');
    expect(fakeFromSchema({ type: 'object', properties: { e: { enum: ['x'] } } }, new Rng(1), { violate: true })).toBe('not-an-object');
  });

  it('required fields: drops the first of several, or flips the type of a single one (unchanged)', () => {
    const props = { a: { type: 'string' }, b: { type: 'string' } };
    expect(fakeFromSchema({ type: 'object', properties: props, required: ['a', 'b'] }, new Rng(1), { violate: true })).not.toHaveProperty('a');
    expect((fakeFromSchema({ type: 'object', properties: props, required: ['b'] }, new Rng(1), { violate: true }) as any).b).toBe(12345);
  });
});

describe('fakeFromSchema public API (regression: it required an Rng, which the package does not export)', () => {
  const schema = { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 9 } }, required: ['id', 'n'] };
  it('works with just a schema, or with { seed, violate }', () => {
    expect(fakeFromSchema(schema)).toEqual(fakeFromSchema(schema, { seed: 1 })); // default seed 1
    expect(fakeFromSchema(schema, { seed: 5 })).toEqual(fakeFromSchema(schema, new Rng(5))); // same stream as an Rng
    expect(fakeFromSchema(schema, { seed: 5 })).toMatchObject({ id: expect.any(String), n: expect.any(Number) });
    const bad = fakeFromSchema(schema, { seed: 5, violate: true }) as Record<string, unknown>;
    expect(typeof bad.id !== 'string' || typeof bad.n !== 'number' || !('id' in bad) || !('n' in bad)).toBe(true);
  });
});
