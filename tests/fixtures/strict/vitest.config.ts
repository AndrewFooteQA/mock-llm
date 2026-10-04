import { defineConfig } from 'vitest/config';

// Run only by tests/unit/strict.test.ts in a child process; never part of the main suite.
export default defineConfig({ test: { include: ['tests/fixtures/strict/*.fixture.ts'] } });
