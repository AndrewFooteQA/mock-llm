import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The installed version of a provider SDK. The compatibility matrix (scripts/compat.mjs) runs this suite against the
 * oldest supported and the latest SDK releases, so assertions about the *SDK's own* behaviour (helpers, error
 * wrapping) are gated on the version that introduced it. Assertions about what the mock sends are never gated.
 */
const require = createRequire(import.meta.url);
export function sdkVersion(pkg: string): string {
  // Walk up from the resolved entry point: some SDKs (openai) don't export ./package.json.
  for (let dir = dirname(require.resolve(pkg)); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (json.name === pkg) return json.version;
    } catch {}
  }
  throw new Error(`sdkVersion: cannot find package.json for ${pkg}`);
}

/** `sdkAtLeast('openai', '7.5.0')`: plain x.y.z comparison (no pre-release tags in SDK releases we test). */
export function sdkAtLeast(pkg: string, min: string): boolean {
  const [a, b] = [sdkVersion(pkg), min].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!;
  return true;
}
