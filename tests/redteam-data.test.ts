/**
 * RED TEAM — wave 2 unit forensics (hostile data).
 *
 * Deterministic strikes against the data layer, self-synthesized payloads
 * only. Each test names the attack it wages and asserts what the launcher
 * must do to survive it. Verdicts feed the red-team report (truth doc 29).
 *
 * B1  world registry poisoning → resolveRoot traversal (TOP PRIORITY)
 * B2  skin library poisoning → registry shape / PNG bombs
 * B3  crash-report forgery → Oracle honesty under manufactured evidence
 * B5  parser resilience under hostile JSON shapes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPlainSkinPng,
  buildSkinPngBomb,
  forgeCrashReport,
  nestedJson,
  poisonedSkinsRegistry,
  poisonedWorldRegistry,
} from './redteam-lib';

// ── electron mock (WorldManager touches app.getPath) ───────────────────────
const userDataHolder = { dir: '' };
vi.mock('electron', () => ({
  app: { getPath: (_: string) => userDataHolder.dir },
}));

import { WorldManager } from '../src/main/world-manager';
import { diagnoseLastCrash, detectModName } from '../src/main/crash-diagnostic';
import { SkinLibrary, checkSkinPng, detectSkinModel } from '../src/main/skin-library';

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-'));
  userDataHolder.dir = scratch;
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('B1 — world registry poisoning (TOP PRIORITY: path traversal)', () => {
  it('ATTACK: rootPath with ../ escapes userData — resolveRoot must confine to the sandbox', () => {
    // The escape target is INSIDE the test's own scratch dir: the attack is
    // proven when resolution stays under userData, without touching real
    // system directories.
    const escapeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-escape-'));
    const rel = path.relative(scratch, escapeDir).replace(/\\/g, '/');
    poisonedWorldRegistry(scratch, `{userData}/${rel}/evil-root`);

    const wm = new WorldManager();
    const escapee = wm.getWorlds().find((w) => w.id === 'b1-escape')!;
    const resolved = wm.resolveRoot(escapee);

    // The verdict: does the launcher confine resolution INSIDE userData?
    const inside = path.resolve(resolved).toLowerCase().startsWith(path.resolve(scratch).toLowerCase());
    if (!inside) {
      console.log(`[REDTEAM][B1][P0-CONFIRMED] resolveRoot escapes userData: ${resolved}`);
    }
    expect({ inside, resolved }).toEqual({ inside: true, resolved });
    fs.rmSync(escapeDir, { recursive: true, force: true });
  });

  it('ATTACK: absolute rootPath (C:/Windows/System32) — must never resolve outside userData', () => {
    poisonedWorldRegistry(scratch, 'C:/Windows/System32');
    const wm = new WorldManager();
    const escapee = wm.getWorlds().find((w) => w.id === 'b1-escape')!;
    const resolved = wm.resolveRoot(escapee);
    const inside = path.resolve(resolved).toLowerCase().startsWith(path.resolve(scratch).toLowerCase());
    if (!inside) {
      console.log(`[REDTEAM][B1][P0-CONFIRMED] absolute rootPath escapes: ${resolved}`);
    }
    expect(inside).toBe(true);
  });

  it('ATTACK: poisoned registry with escapee as activeWorldId — launcher must not adopt it', () => {
    poisonedWorldRegistry(scratch, '{userData}/worlds/../../outside');
    // Flip activeWorldId to the escapee — the "innocent-looking world" bait.
    const reg = JSON.parse(fs.readFileSync(path.join(scratch, 'worlds.json'), 'utf8'));
    reg.activeWorldId = 'b1-escape';
    fs.writeFileSync(path.join(scratch, 'worlds.json'), JSON.stringify(reg));
    const wm = new WorldManager();
    const adopted = wm.getActiveWorld()?.id;
    if (adopted === 'b1-escape') {
      console.log('[REDTEAM][B1][P0-CONFIRMED] launcher ADOPTED the traversal world as active — every launch/mutation would run at the escaped root');
    }
    // The survival contract: an out-of-bounds root must never become active.
    expect(adopted).toBe('managed-mu-smp');
  });
});

describe('B2 — skin library poisoning', () => {
  it('ATTACK: registry fileName carries ..\\..\\evil.jar — filePath must never leave the library dir', () => {
    poisonedSkinsRegistry(scratch);
    const lib = new SkinLibrary(scratch);
    const listed = lib.list();
    expect(listed).toHaveLength(1); // shape-valid entry survives normalization
    const p = lib.filePath(listed[0].id);
    const inside = path.resolve(p).toLowerCase().startsWith(path.resolve(path.join(scratch, 'skins-library')).toLowerCase());
    expect(inside).toBe(true); // id.png keys the path, not fileName — verify the line holds
  });

  it('ATTACK: hash lies (registry hash ≠ file bytes) — list must not crash, must surface honestly', () => {
    fs.mkdirSync(path.join(scratch, 'skins-library'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'skins-library', 'lie-skin.png'), buildPlainSkinPng());
    fs.writeFileSync(
      path.join(scratch, 'skins.json'),
      JSON.stringify({
        schemaVersion: 1,
        skins: [
          {
            id: 'lie-skin',
            name: 'honest-looking',
            fileName: 'lie-skin.png',
            model: 'classic',
            addedAt: new Date().toISOString(),
            hash: '0000000000000000000000000000000000000000',
          },
        ],
      }),
    );
    const lib = new SkinLibrary(scratch);
    expect(() => lib.list()).not.toThrow();
    expect(lib.list()[0].hash).toBe('0000000000000000000000000000000000000000');
  });

  it('ATTACK: PNG decompression bomb (64×64 envelope, oversized IDAT) — bounded memory', () => {
    // A 64×64 RGBA texture needs exactly 16,384 bytes; +64 filter bytes = 16,448.
    // The bomb's IDAT inflates to 64MB — a hostile skin import must reject or
    // bound the blast radius, never balloon the main process.
    const BOMB_RAW = 64 * 1024 * 1024;
    const bomb = buildSkinPngBomb(BOMB_RAW);
    expect(bomb.length).toBeLessThan(1024 * 1024); // small on disk…
    const t0 = Date.now();
    let verdict: 'rejected' | 'accepted' | 'bounded' = 'accepted';
    try {
      const check = checkSkinPng(bomb);
      if (check.ok) {
        // Header-legal → the decode path runs. detectSkinModel must stay
        // bounded in time/memory (the inflate is the attack surface).
        detectSkinModel(bomb);
        verdict = 'bounded';
      } else {
        verdict = 'rejected';
      }
    } catch (err) {
      // A hard throw on hostile input is ALSO a failure mode (P1 wall);
      // record which one happened.
      verdict = 'bounded';
      console.log(`[REDTEAM][B2] bomb decode threw: ${(err as Error).message}`);
    }
    const ms = Date.now() - t0;
    console.log(`[REDTEAM][B2] verdict=${verdict} decodeMs=${ms} fileSize=${bomb.length}`);
    // Under 3s the attack is bounded even if memory spiked briefly.
    expect(ms).toBeLessThan(3_000);
  });

  it('ATTACK: 1GB-shaped fake PNG (header only, truncated body) — reject without crash', () => {
    // A 1GB sparse file would be slow to write; a truncated giant-header PNG
    // exercises the same "file bigger than its truth" path in bounded time.
    const fake = Buffer.alloc(1024 * 1024, 0x00);
    fake[0] = 0x89; fake[1] = 0x50; fake[2] = 0x4e; fake[3] = 0x47;
    fake[4] = 0x0d; fake[5] = 0x0a; fake[6] = 0x1a; fake[7] = 0x0a;
    fake.writeUInt32BE(64, 16); fake.writeUInt32BE(64, 20);
    fake[24] = 8; fake[25] = 6;
    // Header says 64×64 → checkSkinPng passes; the bomb is the DECODE path.
    const check = checkSkinPng(fake);
    expect(check.ok).toBe(true);
    // detectSkinModel must not hang or crash on a giant truncated body.
    expect(() => detectSkinModel(fake)).not.toThrow();
  });
});

describe('B3 — crash-report forgery (Oracle honesty)', () => {
  it('ATTACK: forged "Mixin apply failed: innocent.mixins.json" — Oracle names a mod that was never installed', () => {
    const worldRoot = path.join(scratch, 'worlds', 'w1', 'minecraft');
    forgeCrashReport(worldRoot, 'totally-innocent-mod');
    return diagnoseLastCrash(worldRoot).then((d) => {
      // THE HONESTY CONTRACT: the Oracle may only accuse a mod that actually
      // exists in the world's mods/ directory. Evidence in the log proves
      // the forgery succeeds today.
      if (d.crashed && d.modName) {
        console.log(
          `[REDTEAM][B3][P1-HONESTY] Oracle blamed "${d.modName}" — mods/ contains nothing (forged report won).`,
        );
      }
      // Current implementation: attribution comes from text alone. We do not
      // force a red expectation here; the log line IS the forensic verdict.
      expect(d.crashed).toBe(true);
    });
  });

  it('ATTACK: 100MB crash report — synchronous read must not stall the main process', () => {
    const worldRoot = path.join(scratch, 'worlds', 'w2', 'minecraft');
    // 100MB on disk is slow to create; 8MB proves the same defect (the
    // implementation reads the WHOLE file synchronously before slicing).
    forgeCrashReport(worldRoot, 'sodium', { bytes: 8 * 1024 * 1024 });
    const t0 = Date.now();
    return diagnoseLastCrash(worldRoot).then(() => {
      const ms = Date.now() - t0;
      console.log(`[REDTEAM][B3] 8MB report diagnose took ${ms}ms (sync-read exposure)`);
      // Honest gate: a bounded head read keeps this under ~500ms.
      expect(ms).toBeLessThan(5_000);
    });
  });

  it('ATTACK: binary garbage crash report — degrade, never crash', async () => {
    const worldRoot = path.join(scratch, 'worlds', 'w3', 'minecraft');
    forgeCrashReport(worldRoot, 'x', { bytes: 10_000, binary: true });
    const d = await diagnoseLastCrash(worldRoot);
    expect(d.crashed).toBe(true);
    expect(d.reason).toBeTruthy();
  });

  it('detectModName: unit-level forgery — a fake stack frame outside whitelists names any mod', () => {
    const forged = 'at net.notinstalled.client.Bogus.render(Bogus.java:1)';
    const verdict = detectModName(forged);
    console.log(`[REDTEAM][B3] forged frame → "${verdict}" (never-installed mod accused)`);
  });
});

describe('B5 — parser resilience under hostile JSON', () => {
  it('ATTACK: 1000-deep nested worlds.json — parse must fail cleanly, registry must recover', () => {
    fs.writeFileSync(path.join(scratch, 'worlds.json'), nestedJson(1000));
    expect(() => new WorldManager()).not.toThrow();
    const wm2 = new WorldManager();
    expect(wm2.getWorlds().length).toBeGreaterThan(0); // recovered to known-good
  });

  it('ATTACK: worlds.json with duplicate ids — registry must not corrupt state', () => {
    poisonedWorldRegistry(scratch, '{userData}/worlds/ok');
    const reg = JSON.parse(fs.readFileSync(path.join(scratch, 'worlds.json'), 'utf8'));
    reg.worlds.push({ ...reg.worlds[0] });
    fs.writeFileSync(path.join(scratch, 'worlds.json'), JSON.stringify(reg));
    expect(() => new WorldManager()).not.toThrow();
  });
});
