// Run only by tests/unit/jest-adapter.test.ts (Jest in ESM mode, against the built dist/).
export default {
  rootDir: new URL('.', import.meta.url).pathname,
  testMatch: ['<rootDir>/*.fixture.mjs'],
  testEnvironment: 'node',
  transform: {},
};
