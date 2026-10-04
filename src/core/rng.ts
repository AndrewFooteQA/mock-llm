/** Small seeded PRNG (mulberry32) so lorem text, ids and chaos faults reproduce. */
export class Rng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  id(length = 24): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[this.int(alphabet.length)];
    return out;
  }
}

/** Stable 32-bit hash of a string (FNV-1a), used for deterministic embeddings. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic unit-length embedding vector for a text (same text → same vector). */
export function embedding(text: string, dims: number): Float32Array {
  const rng = new Rng(hashString(text));
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = rng.next() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}
