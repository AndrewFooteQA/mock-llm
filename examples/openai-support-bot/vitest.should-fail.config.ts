import { defineConfig } from 'vitest/config';

// Only the deliberately failing tests (see test/check-expected-failures.mjs).
export default defineConfig({ test: { include: ['test/should-fail/**/*.ts'] } });
