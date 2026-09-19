import { defineConfig } from 'vitest/config';

/**
 * Pure-logic test layer: node environment, no jsdom, no electron mocks.
 * Only modules whose logic runs without an Electron runtime are imported
 * (extracted pure functions in update-checker / crash-diagnostic /
 * identity-service / net).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
