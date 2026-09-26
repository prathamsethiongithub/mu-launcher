/**
 * RED TEAM — wave 1 unit forensics (malice-lite: the confused user).
 *
 * A5  hostile world names through the real createWorld path
 * A5b renderer-supplied settingsPath — arbitrary-path copy custody check
 * A6  read-only / adversarial filesystem — honest failures, never crashes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOSTILE_NAMES } from './redteam-lib';

const userDataHolder = { dir: '' };
vi.mock('electron', () => ({
  app: { getPath: (_: string) => userDataHolder.dir },
}));

import { WorldManager } from '../src/main/world-manager';
import { SkinLibrary } from '../src/main/skin-library';

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-u-'));
  userDataHolder.dir = scratch;
});

afterEach(() => {
  try { fs.chmodSync(scratch, 0o700); } catch { /* */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('A5 — hostile world names through createWorld', () => {
  it('ATTACK: traversal/separators/RTL/control-char names — created world stays in worlds/<uuid>/', () => {
    const wm = new WorldManager();
    for (const name of HOSTILE_NAMES) {
      const before = new Set(wm.getWorlds().map((w) => w.id));
      const world = wm.createWorld({ name, version: '1.21.1', loader: 'fabric' });
      if (world) {
        // Whatever the name, the root MUST be under {userData}/worlds/<uuid>/.
        expect(world.rootPath.startsWith('{userData}/worlds/')).toBe(true);
        expect(world.rootPath.endsWith('/minecraft')).toBe(true);
        // And the id — never the name — keys the directory.
        expect(fs.existsSync(path.join(scratch, 'worlds', world.id))).toBe(true);
        before.add(world.id);
      } else {
        // Rejection is also survival — as long as it is deliberate.
        console.log(`[REDTEAM][A5] createWorld rejected name ${JSON.stringify(name.slice(0, 24))}`);
      }
    }
    // The registry survives all of them without corruption.
    expect(() => wm.getWorlds()).not.toThrow();
  });

  it('ATTACK: duplicate-hostile names do not collide on disk', () => {
    const wm = new WorldManager();
    const w1 = wm.createWorld({ name: '⚔️🔥💀'.repeat(30), version: '1.21.1', loader: 'fabric' });
    const w2 = wm.createWorld({ name: '⚔️🔥💀'.repeat(30), version: '1.21.1', loader: 'fabric' });
    if (w1 && w2) expect(w1.id).not.toBe(w2.id); // ids are uuids — names never key anything
  });

  it('ATTACK: createWorld output name never corrupts the registry round-trip', () => {
    const wm = new WorldManager();
    for (const name of HOSTILE_NAMES) wm.createWorld({ name, version: '1.21.1', loader: 'fabric' });
    // Reload from disk — the JSON round-trip must restore every world.
    const wm2 = new WorldManager();
    expect(wm2.getWorlds().length).toBe(wm.getWorlds().length);
  });
});

describe('A5b — renderer-supplied settingsPath (custody check)', () => {
  it('ATTACK: settingsPath pointing OUTSIDE userData gets copied into the world root', () => {
    // The renderer can pass any path (spec.settingsPath flows straight into
    // createWorld). If the app copies from an arbitrary absolute path, the
    // bridge is an arbitrary-file-read primitive (copy bytes into the world
    // root where the user/attacker can read them).
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-secret-'));
    const secretFile = path.join(secretDir, 'options.txt');
    fs.writeFileSync(secretFile, 'SECRET-BYTES-OUTSIDE-USERDATA');

    const wm = new WorldManager();
    const world = wm.createWorld({
      name: 'custody-probe',
      version: '1.21.1',
      loader: 'fabric',
      settingsPath: secretDir,
    });
    const worldRoot = world ? path.join(scratch, 'worlds', world.id, 'minecraft') : null;
    const copied = worldRoot && fs.existsSync(path.join(worldRoot, 'options.txt'))
      ? fs.readFileSync(path.join(worldRoot, 'options.txt'), 'utf8')
      : null;

    if (copied?.includes('SECRET-BYTES-OUTSIDE-USERDATA')) {
      console.log('[REDTEAM][A5b] WorldManager-level copy still permissive (by layering) — the bridge-level custody guard is asserted in the E2E spec (tests/e2e/redteam-assault.spec.ts)');
    }
    // Survival at THIS layer: createWorld must not crash or corrupt state
    // regardless of what path arrives. The refusal contract lives at the
    // IPC bridge (production fix in index.ts: pendingSettingsPaths).
    expect(() => wm.getWorlds()).not.toThrow();
    fs.rmSync(secretDir, { recursive: true, force: true });
  });
});

describe('A6 — adversarial filesystem (read-only / hostile)', () => {
  it('ATTACK: skins.json read-only — list works, mutations degrade honestly', () => {
    fs.writeFileSync(
      path.join(scratch, 'skins.json'),
      JSON.stringify({ schemaVersion: 1, skins: [] }),
    );
    fs.chmodSync(path.join(scratch, 'skins.json'), 0o444);
    const lib = new SkinLibrary(scratch);
    expect(() => lib.list()).not.toThrow();
    // Import will write the PNG fine but the registry rename fails —
    // it must THROW-or-return-rejected, never silently claim success.
    let verdict = 'no-crash';
    try {
      const png = Buffer.alloc(64 * 64 * 4, 0xff);
      const res = lib.importBuffer(png, 'ro-test');
      verdict = res.status === 'added' ? 'FALSE-SUCCESS' : 'honest';
    } catch (err) {
      verdict = `throws: ${(err as Error).message.slice(0, 60)}`;
    }
    console.log(`[REDTEAM][A6] read-only skins.json import verdict: ${verdict}`);
    expect(verdict).not.toBe('FALSE-SUCCESS');
  });

  it('ATTACK: skins-library dir read-only — import must not claim success while the PNG write fails', () => {
    fs.mkdirSync(path.join(scratch, 'skins-library'), { recursive: true });
    fs.chmodSync(path.join(scratch, 'skins-library'), 0o555);
    const lib = new SkinLibrary(scratch);
    let verdict = 'no-crash';
    try {
      const png = Buffer.alloc(64 * 64 * 4, 0xff);
      const res = lib.importBuffer(png, 'ro-dir');
      verdict = res.status === 'added' ? 'FALSE-SUCCESS' : 'honest';
    } catch (err) {
      verdict = `throws: ${(err as Error).message.slice(0, 60)}`;
    }
    console.log(`[REDTEAM][A6] read-only library dir verdict: ${verdict}`);
    expect(verdict).not.toBe('FALSE-SUCCESS');
  });

  it('ATTACK: worlds root occupied — createWorld degrades without corrupting the registry', () => {
    const wm = new WorldManager();
    // Occupy the worlds dir with a FILE where a DIRECTORY must be — the
    // classic mkdir collision.
    fs.writeFileSync(path.join(scratch, 'worlds'), 'i am a file, not a dir');
    const world = wm.createWorld({ name: 'occupied', version: '1.21.1', loader: 'fabric' });
    // Survival: null (honest refusal) — and the registry stays loadable.
    if (world) {
      // Some mkdirSync flavors fail through; then the registry must not
      // contain a world whose root does not exist.
      expect(world.broken).toBe(true);
    }
    expect(() => new WorldManager()).not.toThrow();
  });
});
