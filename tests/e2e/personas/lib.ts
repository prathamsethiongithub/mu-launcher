/**
 * Persona sandbox library — deterministic seeds + environment constraints.
 *
 * A persona = seed(dir) + launch args + runtime constraints (CPU throttle,
 * network patch). Everything here is TEST-SIDE ONLY: no production file is
 * read or written. Seeds write into the harness's throwaway userData dir,
 * mirroring the exact on-disk shapes the production loaders parse
 * (skins.json per skin-library.ts, worlds.json per world-manager.ts,
 * identity.json per identity-service.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { ElectronApplication, CDPSession } from 'playwright';

// ── PNG builder (same geometry the app's own slim-detector parses) ─────────

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 64×64 RGBA skin PNG, deterministic per shade byte. */
export function buildSkinPng(shade: number): Buffer {
  const raw = Buffer.alloc((64 * 4 + 1) * 64);
  let p = 0;
  for (let y = 0; y < 64; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < 64; x++) {
      raw[p++] = (x * 2 + shade) & 0xff;
      raw[p++] = (y * 3) & 0xff;
      raw[p++] = 0x40;
      raw[p++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Skins registry ────────────────────────────────────────────────────────

export interface SeedSkin {
  id: string;
  name: string;
  /** When omitted, no PNG is written — the "missing file" card variant. */
  png?: Buffer;
  model?: 'classic' | 'slim';
}

/** Write {userData}/skins.json (+ PNGs) in the exact production shape. */
export function seedSkins(dir: string, skins: SeedSkin[]): void {
  const libDir = path.join(dir, 'skins-library');
  fs.mkdirSync(libDir, { recursive: true });
  const entries = skins.map((s) => {
    if (s.png) fs.writeFileSync(path.join(libDir, `${s.id}.png`), s.png);
    return {
      id: s.id,
      name: s.name,
      fileName: `${s.id}.png`,
      model: s.model ?? ('classic' as const),
      addedAt: '2026-09-01T12:00:00.000Z', // fixed timestamp — deterministic
      hash: createHash('sha1').update(s.png ?? Buffer.from(s.id)).digest('hex'),
    };
  });
  fs.writeFileSync(
    path.join(dir, 'skins.json'),
    JSON.stringify({ schemaVersion: 1, skins: entries }, null, 2),
  );
}

// ── Worlds registry ───────────────────────────────────────────────────────

export interface SeedWorld {
  id: string;
  name: string;
  type?: 'managed' | 'personal';
  version?: string;
  loader?: 'vanilla' | 'fabric' | 'forge' | 'quilt' | 'neoforge';
  loaderVersion?: string;
}

/** Write {userData}/worlds.json in the exact production shape (schema 1). */
export function seedWorlds(dir: string, worlds: SeedWorld[]): void {
  const reg = {
    schemaVersion: 1,
    activeWorldId: worlds[0]?.id ?? null,
    worlds: worlds.map((w) => ({
      id: w.id,
      name: w.name,
      type: w.type ?? ('personal' as const),
      version: w.version ?? '1.21.1',
      loader: w.loader ?? ('fabric' as const),
      loaderVersion: w.loaderVersion ?? '0.16.9',
      rootPath: '{userData}/minecraft',
      assignedServer: null,
      mods: [],
      resourcePacks: [],
      ramAllocation: 4096,
      resolution: null,
      javaPath: null,
      iconPath: null,
      createdAt: 1725148800000, // fixed epoch — deterministic
      lastPlayedAt: null,
      imported: false,
      broken: false,
    })),
  };
  fs.writeFileSync(path.join(dir, 'worlds.json'), JSON.stringify(reg, null, 2));
}

// ── Identity (accounts) ───────────────────────────────────────────────────

export interface SeedAccount {
  id: string;
  type: 'microsoft' | 'offline';
  username: string;
  uuid: string;
}

/** Write identity.json with a full valid shape (accounts + session). */
export function seedIdentity(dir: string, accounts: SeedAccount[]): void {
  const iso = '2026-09-01T12:00:00.000Z';
  fs.writeFileSync(
    path.join(dir, 'identity.json'),
    JSON.stringify(
      {
        accounts: accounts.map((a) => ({
          ...a,
          createdAt: iso,
          lastUsedAt: iso,
        })),
        activeAccountId: accounts[0]?.id ?? undefined,
        sessions: Object.fromEntries(
          accounts.map((a) => [a.id, { accountId: a.id, authenticated: true, lastValidatedAt: iso }]),
        ),
      },
      null,
      2,
    ),
  );
}

/** The harness's default post-onboarding account (single offline tester). */
export const defaultAccount: SeedAccount = {
  id: 'e2e-offline',
  type: 'offline',
  username: 'e2e-tester',
  uuid: '99999999-9999-3999-8999-999999999999',
};

// ── Runtime constraints ───────────────────────────────────────────────────

/** Attach a CDP session to the window target and throttle CPU N×. */
export async function throttleCpu(
  app: ElectronApplication,
  rate: number,
): Promise<CDPSession> {
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

/**
 * Fetch-fault injection for the MAIN process (test-side only).
 *
 * The main process talks network exclusively through Node's global fetch
 * (net.ts timedFetch resolves `fetch` at each call site, index.ts's
 * fetch-version-list likewise) — so patching globalThis.fetch inside the
 * running main process gives deterministic, CI-safe network faults and
 * canned responses without touching a single production line.
 *
 * Modes:
 *  - fail: every allowed-URL fetch rejects after `delayMs` (simulates
 *    unreachable network / timeouts)
 *  - respond: matching URL patterns get a canned JSON body (simulates
 *    recovery — deterministic, no real network needed)
 *  - pass: URL patterns matched are handled; anything else falls through
 *    to the real fetch (leave closed in CI where no egress exists)
 */
export async function patchMainFetch(
  app: ElectronApplication,
  mode: 'fail' | 'respond',
  opts?: {
    /** Substrings; a URL must contain at least one to be affected. Empty = all URLs. */
    matchUrls?: string[];
    /** canned responses tried in order; first pattern match wins. */
    respond?: { match: string; status: number; body: unknown }[];
    delayMs?: number;
  },
): Promise<void> {
  await app.evaluate(
    ({ }, cfg: {
      mode: 'fail' | 'respond';
      matchUrls: string[];
      respond: { match: string; status: number; body: unknown }[];
      delayMs: number;
    }) => {
      const g = globalThis as unknown as { fetch: typeof fetch };
      const realFetch = g.fetch.bind(globalThis);
      const affected = (url: string): boolean =>
        cfg.matchUrls.length === 0 || cfg.matchUrls.some((m) => url.includes(m));
      const canned = (url: string): { status: number; body: unknown } | null => {
        for (const r of cfg.respond) if (url.includes(r.match)) return r;
        return null;
      };
      const patched: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!affected(url)) return realFetch(input as Parameters<typeof fetch>[0], init);
        if (cfg.mode === 'fail') {
          await new Promise((r) => setTimeout(r, cfg.delayMs));
          throw new Error('[e2e-injected] network unreachable');
        }
        const hit = canned(url);
        if (!hit) return realFetch(input as Parameters<typeof fetch>[0], init);
        const body = JSON.stringify(hit.body);
        return new Response(body, {
          status: hit.status,
          headers: { 'content-type': 'application/json' },
        });
      };
      g.fetch = patched;
    },
    {
      mode,
      matchUrls: opts?.matchUrls ?? [],
      respond: opts?.respond ?? [],
      delayMs: opts?.delayMs ?? 150,
    },
  );
}
