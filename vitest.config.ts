import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Library tests only. Each examples/* project runs its own suite (npm run test:examples).
    include: ['tests/**/*.test.ts'],
  },
});
