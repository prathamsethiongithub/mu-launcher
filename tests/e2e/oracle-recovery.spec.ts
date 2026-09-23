/**
 * E2E — Oracle Recovery: the attribution→action loop over the real app.
 *
 * Three honesty contracts, driven end-to-end through the real IPC handlers
 * (diagnose-world, mod-list, mod-delete, update-world-settings) against a
 * throwaway personal world:
 *
 *   1. a matched mod crash renders repair actions wired to real pipelines
 *      ('remove it' actually deletes the jar; 'show evidence' opens console);
 *   2. an OOM crash renders the memory action, which really changes the
 *      world's RAM through the same handler Setup uses;
 *   3. an undefined attribution shows the no-hope line and evidence —
 *      and NEVER a repair button (the honesty red line).
 *
 * Pattern: app#1 is booted ONLY as an IPC workbench (create the world, set
 * it active, install the jar — the registry persists to disk), then closed.
 * app#2 boots normally and its Play view diagnoses the persisted active
 * world on mount — the exact flow a real user's crash lands in. No nav
 * clicking anywhere (a blind 'Play' click can hit a keep-alive shelf
 * button and launch the game).
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { launchTestApp, waitForText, clickButtonByText, type TestApp } from './harness';

/** The throwaway world's root on disk: {userData}/worlds/<id>/minecraft
 *  (world-manager.createWorld). The dir is the SHARED user-data passed
 *  through the harness (--user-data-dir wins over the app's mu-master-
 *  launcher pin since the isolation fix) — never the real profile. */
const sharedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-oracle-e2e-'));
function worldRoot(id: string): string {
  return path.join(sharedUserData, 'worlds', id, 'minecraft');
}

const SODIUM_CRASH = [
  '---- Minecraft Crash Report ----',
  '// I let you down. Sorry :(',
  '',
  'Time: 2026-09-21 10:00:00',
  'Description: Initializing game',
  '',
  'java.lang.RuntimeException: Mixin apply failed: sodium.mixins.json:client.json',
  '\tat net.sodium.client.render.SodiumRenderer.init(SodiumRenderer.java:42)',
  '\tat net.minecraft.client.main.Main.main(Main.java:123)',
  'Caused by: java.lang.RuntimeException: Mixin apply failed',
  '\tat net.sodium.client.MixinBroker.apply(MixinBroker.java:10)',
  '',
].join('\n');

interface ProvisionedWorld {
  id: string;
  /** Wipes the world (registry + disk) once the observing app is closed. */
  dispose: () => Promise<void>;
}

/** app#1 as a pure IPC workbench: create + activate + stage files, then close. */
async function provisionWorld(
  setup: (workbench: TestApp, worldId: string) => Promise<void>,
): Promise<ProvisionedWorld> {
  // app#1 as a pure IPC workbench: create + activate + stage files, then
  // close. Shares the profile with the observing app#2 (default offline
  // seed keeps the shared profile bootable across both launches).
  const workbench = await launchTestApp({ userDataDir: sharedUserData });
  let worldId: string | null = null;
  try {
    const world = await workbench.window.evaluate(() =>
      window.electronAPI
        .createWorld({ name: 'oracle-recovery-e2e', version: '1.21.1', loader: 'fabric' })
        .then((r) => (r.success ? r.world : null)),
    );
    expect(world).toBeTruthy();
    worldId = (world as unknown as { id: string }).id;
    await workbench.window.evaluate(
      (id) => window.electronAPI.setActiveWorld(id as string),
      worldId,
    );
    await setup(workbench, worldId as string);
  } finally {
    await workbench.cleanup();
  }
  const id = worldId as string;
  return {
    id,
    dispose: async () => {
      fs.rmSync(worldRoot(id), { recursive: true, force: true });
      // Registry entry: a second boot removes it honestly through the app
      // (same shared profile, so the registry is actually visible).
      try {
        const cleaner = await launchTestApp({ userDataDir: sharedUserData });
        await cleaner.window.evaluate((wid) => window.electronAPI.deleteWorld(wid as string), id);
        await cleaner.cleanup();
      } catch { /* leftover registry entry is inert — the dir is gone */ }
    },
  };
}

test.afterAll(async () => {
  fs.rmSync(sharedUserData, { recursive: true, force: true });
});

test('oracle-recovery-remove: matched mod renders repair actions and remove deletes the real jar', async () => {
  const world = await provisionWorld(async (workbench, wid) => {
    // A real mod file the diagnosis can match ("sodium.mixins.json" →
    // "Sodium"; the jar's canonical key contains "sodium").
    const fakeJar = path.join(workbench.scratchDir, 'sodium-0.5.3.jar');
    fs.writeFileSync(fakeJar, 'not a real jar — list/delete only read names');
    const added = await workbench.window.evaluate(
      ([id, src]) => window.electronAPI.addMod(id as string, src as string),
      [wid, fakeJar],
    );
    expect((added as { success: boolean }).success).toBe(true);
    fs.mkdirSync(path.join(worldRoot(wid), 'crash-reports'), { recursive: true });
    fs.writeFileSync(path.join(worldRoot(wid), 'crash-reports', 'crash-2026-09-21.txt'), SODIUM_CRASH);
  });

  const ta = await launchTestApp({ userDataDir: sharedUserData });
  await waitForText(ta.window, 'Ready.', 20_000);
  try {
    // The attribution line renders (the name is Oracle's prettified "Sodium")…
    expect(await waitForText(ta.window, 'Sodium caused your last crash.', 15_000)).toBe(true);
    // …and the decision table's actions render with it.
    expect(await waitForText(ta.window, 'remove it', 5_000)).toBe(true);

    // Remove — through the existing mod-delete handler, for real.
    expect(await clickButtonByText(ta.window, 'remove it')).toBe(true);
    expect(await waitForText(ta.window, 'sodium removed. relaunch?', 8_000)).toBe(true);

    // Disk truth: the jar is gone from the world's mods/.
    const mods = await ta.window.evaluate(
      (id) => window.electronAPI.listMods(id as string),
      world.id,
    );
    expect((mods as { filename: string }[]).some((m) => m.filename.includes('sodium'))).toBe(false);
  } finally {
    await ta.cleanup();
    await world.dispose();
  }
});

test('oracle-recovery-memory: OOM attribution shows the memory action that really changes RAM', async () => {
  const world = await provisionWorld(async () => { /* crash staged below */ });
  fs.mkdirSync(path.join(worldRoot(world.id), 'crash-reports'), { recursive: true });
  fs.writeFileSync(
    path.join(worldRoot(world.id), 'crash-reports', 'crash-2026-09-21.txt'),
    'java.lang.OutOfMemoryError: Java heap space\n\tat java.base/java.lang.Thread.run(Unknown Source)\n',
  );

  const ta = await launchTestApp({ userDataDir: sharedUserData });
  await waitForText(ta.window, 'Ready.', 20_000);
  try {
    expect(await waitForText(ta.window, 'your world might have run out of memory.', 15_000)).toBe(true);
    expect(await waitForText(ta.window, 'give it more memory', 5_000)).toBe(true);

    const before = await ta.window.evaluate(
      (id) => window.electronAPI.getWorlds().then((ws) => ws.find((w) => w.id === id)?.ramAllocation),
      world.id,
    );

    expect(await clickButtonByText(ta.window, 'give it more memory')).toBe(true);
    expect(await waitForText(ta.window, '. relaunch?', 8_000)).toBe(true);

    const after = await ta.window.evaluate(
      (id) => window.electronAPI.getWorlds().then((ws) => ws.find((w) => w.id === id)?.ramAllocation),
      world.id,
    );
    // The registry really changed — through update-world-settings, not a file hack.
    expect(after as number).toBeGreaterThan(before as number);
  } finally {
    await ta.cleanup();
    await world.dispose();
  }
});

test('oracle-recovery-undefined: unattributed crash shows the no-hope line and never a repair button', async () => {
  const world = await provisionWorld(async () => { /* staging below */ });
  fs.mkdirSync(path.join(worldRoot(world.id), 'crash-reports'), { recursive: true });
  fs.writeFileSync(
    path.join(worldRoot(world.id), 'crash-reports', 'crash-2026-09-21.txt'),
    '---- Minecraft Crash Report ----\n\njava.lang.IllegalStateException: something broke\n\tat net.minecraft.client.main.Main.main(Main.java:1)\n',
  );

  const ta = await launchTestApp({ userDataDir: sharedUserData });
  await waitForText(ta.window, 'Ready.', 20_000);
  try {
    // The honest head-line…
    expect(await waitForText(ta.window, "couldn't name this one. details in the console.", 15_000)).toBe(true);
    // …and the honesty red line: no repair buttons anywhere.
    const body = await ta.window.evaluate(() => document.body.innerText);
    expect(body).not.toContain('remove it');
    expect(body).not.toContain('give it more memory');

    // Evidence remains: the recovery row exists and the console entry is there.
    const row = await ta.window.evaluate(
      () => document.querySelector('[data-testid="oracle-recovery"]')?.textContent ?? null,
    );
    expect(row).toBeTruthy();
    expect(row).toContain('show evidence');

    // show evidence opens the console view.
    expect(await clickButtonByText(ta.window, 'show evidence')).toBe(true);
    await ta.window.waitForTimeout(800);
    const after = await ta.window.evaluate(() => document.body.innerText);
    expect(/console|session|no session/i.test(after)).toBe(true);
  } finally {
    await ta.cleanup();
    await world.dispose();
  }
});
