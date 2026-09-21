import { defineConfig } from 'playwright/test';

/**
 * Ember E2E — Playwright driving the real compiled Electron app
 * (out/main/index.js). Each test file gets its own app instance via the
 * shared harness in tests/e2e/harness.ts.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  globalTimeout: 5 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  use: {
    trace: 'off',
  },
});
