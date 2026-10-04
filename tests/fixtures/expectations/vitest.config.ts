import { defineConfig } from 'vitest/config';

// Run only by tests/unit/expectations.test.ts in a child process; never part of the main suite.
export default defineConfig({ test: { include: ['tests/fixtures/expectations/*.fixture.ts'] } });
