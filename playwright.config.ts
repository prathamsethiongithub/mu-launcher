import { defineConfig } from 'playwright/test';

/**
 * Ember E2E — Playwright driving the real compiled Electron app
 * (out/main/index.js). Each test file gets its own app instance via the
 * shared harness in tests/e2e/harness.ts.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  // 5 min covered the original 17-test smoke floor; the persona suite adds
  // five full app boots (heavy seeds, CPU throttling, network phases) and the
  // journey suite adds eight more boots (SIGKILL respawn chains + one real
  // first-Play measurement with real Mojang egress) — 20 min keeps the whole
  // e2e gate inside CI without masking a hang.
  globalTimeout: 20 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  use: {
    trace: 'off',
  },
});
