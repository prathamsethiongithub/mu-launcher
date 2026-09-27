/**
 * First-Contact Pack, deliverable 1 — the expectation line.
 *
 * E2E proof that the one-line promise under the launch button behaves exactly
 * as specified:
 *   - it appears on a world that has NEVER been launched
 *   - it is gone on a world that HAS been launched
 *   - it stays gone across a restart once the launch history is persisted
 *
 * The signal is real world state (`World.lastPlayedAt`, set by
 * world-manager.ts on game exit), so every case here is driven by the same
 * on-disk registry the production app parses — no production file is touched.
 *
 * Copy is asserted literally (not imported) to match the other E2E specs, which
 * do not reach into src/.
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchTestApp, type TestApp } from './harness';
import { seedIdentity, seedWorlds } from './personas/lib';

/** Source of truth: src/shared/first-boot.ts (FIRST_BOOT_COPY). */
const EXPECTED_COPY = "first time takes a few minutes. it's worth it.";

const OFFLINE_ACCOUNT = [
  {
    id: 'e2e-offline',
    type: 'offline' as const,
    username: 'e2e-tester',
    uuid: '99999999-9999-3999-8999-999999999999',
  },
];

/** Post-onboarding state with a world that has never been launched. */
const seedNeverLaunched = (dir: string): void => {
  seedIdentity(dir, OFFLINE_ACCOUNT);
  seedWorlds(dir, [{ id: 'w-first', name: 'Ember SMP', type: 'personal' }]);
};

/** Same, but the world has a launch history (lastPlayedAt set). */
const seedAlreadyLaunched = (dir: string): void => {
  seedNeverLaunched(dir);
  const registryPath = path.join(dir, 'worlds.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.worlds[0].lastPlayedAt = 1725148800000; // fixed epoch — deterministic
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
};

test('first-boot note appears on a world that has never been launched', async () => {
  const ta: TestApp = await launchTestApp({ seed: seedNeverLaunched });
  try {
    const note = ta.window.getByTestId('first-boot-note');
    await expect(note).toBeVisible({ timeout: 25_000 });
    await expect(note).toHaveText(EXPECTED_COPY);
  } finally {
    await ta.cleanup();
  }
});

test('first-boot note is absent once the world has a launch history', async () => {
  const ta: TestApp = await launchTestApp({ seed: seedAlreadyLaunched });
  try {
    // Let the Play view settle (auth check + world load) before judging absence,
    // so a slow first render cannot pass this test by accident.
    await ta.window.waitForTimeout(4_000);
    await expect(ta.window.getByTestId('first-boot-note')).toHaveCount(0);
  } finally {
    await ta.cleanup();
  }
});

test('first-boot note disappears after the first launch (survives restart)', async () => {
  // Own the profile so two boots share one userData dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-first-boot-'));
  try {
    // Boot #1 — fresh world: the promise is made.
    const first = await launchTestApp({ seed: seedNeverLaunched, userDataDir: dir });
    try {
      await expect(first.window.getByTestId('first-boot-note')).toBeVisible({ timeout: 25_000 });
    } finally {
      await first.cleanup();
    }

    // The first launch happened and the game exited: world-manager.ts persisted
    // lastPlayedAt. Reproduce that exact state transition on disk.
    const registryPath = path.join(dir, 'worlds.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.worlds[0].lastPlayedAt = Date.now();
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    // Boot #2 — same profile: the promise is spent, forever.
    const second = await launchTestApp({ userDataDir: dir });
    try {
      await second.window.waitForTimeout(4_000);
      await expect(second.window.getByTestId('first-boot-note')).toHaveCount(0);
    } finally {
      await second.cleanup();
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
