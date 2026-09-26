/**
 * RED TEAM synthetic payload library.
 *
 * Every attack vector in the red-team campaign is manufactured HERE, inside
 * the test tree — garbage bytes, poisoned JSON, decompression bombs, hostile
 * timestamps. No third-party "attack tooling" is imported: the brief demands
 * self-synthesized payloads only. These helpers never touch the network and
 * never leave the test sandbox.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** A minimal valid offline identity seed (same shape as the E2E default). */
export function offlineIdentitySeed(dir: string): void {
  const iso = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'identity.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'e2e-offline',
          type: 'offline',
          username: 'e2e-tester',
          uuid: '99999999-9999-3999-8999-999999999999',
          createdAt: iso,
          lastUsedAt: iso,
        },
      ],
      activeAccountId: 'e2e-offline',
      sessions: {
        'e2e-offline': { accountId: 'e2e-offline', authenticated: true, lastValidatedAt: iso },
      },
    }),
  );
}

/** B1 — a worlds.json entry whose rootPath escapes userData via `..`. */
export function poisonedWorldRegistry(dir: string, escapeRoot: string): void {
  const escapedTemplate = escapeRoot.replace(/\\/g, '/');
  fs.writeFileSync(
    path.join(dir, 'worlds.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeWorldId: 'b1-escape',
      worlds: [
        {
          id: 'managed-mu-smp',
          name: 'Managed World',
          type: 'managed',
          version: '1.21.1',
          loader: 'fabric',
          loaderVersion: '',
          rootPath: '{userData}/minecraft',
          assignedServer: null,
          mods: [],
          resourcePacks: [],
          ramAllocation: 4096,
          resolution: null,
          javaPath: null,
          iconPath: null,
          createdAt: 0,
          lastPlayedAt: null,
          imported: false,
          broken: false,
        },
        {
          id: 'b1-escape',
          name: 'innocent-looking world',
          type: 'personal',
          version: '1.21.1',
          loader: 'fabric',
          loaderVersion: '',
          rootPath: escapedTemplate,
          assignedServer: null,
          mods: [],
          resourcePacks: [],
          ramAllocation: 4096,
          resolution: null,
          javaPath: null,
          iconPath: null,
          createdAt: 0,
          lastPlayedAt: null,
          imported: false,
          broken: false,
        },
      ],
    }),
  );
}

/**
 * B3 — forge a crash report that "proves" an innocent mod broke the game.
 * Mirrors Fabric's real signatures the Oracle's detectors match on.
 */
export function forgeCrashReport(
  worldRoot: string,
  modId: string,
  opts?: { bytes?: number; binary?: boolean; oom?: boolean },
): string {
  const dir = path.join(worldRoot, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  const lines = opts?.oom
    ? [
        '---- Minecraft Crash Report ----',
        'Description: Initializing game',
        'java.lang.OutOfMemoryError: Java heap space',
      ]
    : [
        '---- Minecraft Crash Report ----',
        'Description: Initializing game',
        `Mixin apply failed: ${modId}.mixins.json:client.json`,
        'at ' + modId + '.client.render.Wadable.doRender(Wadable.java:41)',
      ];
  let body = lines.join('\n');
  if (opts?.bytes) {
    // Pad to the requested size so the report stresses the reader.
    while (body.length < opts.bytes) body += (opts.binary ? '\u0000\u00ffJUNK' : '\n// padding noise') as string;
  }
  const name = `crash-2026-09-26_${Date.now()}.txt`;
  fs.writeFileSync(path.join(dir, name), opts?.binary ? Buffer.from(body, 'utf8') : body);
  return name;
}

/**
 * B2 — build a REAL, decodable 64×64 PNG whose IDAT inflates to `targetBytes`
 * when decompressed (a decompression bomb inside a skin-shaped envelope).
 */
export function buildSkinPngBomb(targetBytes: number): Buffer {
  // 64×64 RGBA = 16,384 raw bytes; a bomb needs an oversize INFLATED stream.
  // Level 9 over all-zero rows: the file on disk stays tiny while INFLATE
  // materializes `targetBytes` inside the reader — the memory bomb lives in
  // the decompressor's output buffer, not in the file.
  const raw = Buffer.alloc(targetBytes, 0);
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks: Buffer[] = [];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA — detectSkinModel's decode path
  const pushChunk = (type: string, data: Buffer): void => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    chunks.push(len, body, crc);
  };
  pushChunk('IHDR', ihdr);
  // The IDAT decompresses to targetBytes (16,448 needed for a real 64×64
  // RGBA + filter bytes; the surplus is where the memory bomb lives).
  pushChunk('IDAT', idat);
  pushChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

/** PNG CRC32 (the standard polynomial, no table). */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

/** Build a plain, valid 64×64 opaque PNG (the honest control sample). */
export function buildPlainSkinPng(): Buffer {
  const raw = Buffer.alloc(64 * 64 * 4, 0xff);
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks: Buffer[] = [];
  const pushChunk = (type: string, data: Buffer): void => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    chunks.push(len, body, crc);
  };
  pushChunk('IHDR', ihdr);
  pushChunk('IDAT', idat);
  pushChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

/** B2 — skins.json whose fileName field carries an escape attempt. */
export function poisonedSkinsRegistry(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'skins.json'),
    JSON.stringify({
      schemaVersion: 1,
      skins: [
        {
          id: 'evil-skin-1',
          name: 'innocent',
          fileName: '..\\..\\evil.jar',
          model: 'classic',
          addedAt: new Date().toISOString(),
          hash: 'deadbeef',
        },
      ],
    }),
  );
}

/** A1/A5 — hostile world names: separators, traversal, unicode, RTL. */
export const HOSTILE_NAMES = [
  '..\\..\\evil',
  '../../evil',
  'a/b\\c',
  'x'.repeat(500),
  '⚔️🔥💀'.repeat(30),
  '\u202Eevil.exe',
  'name\u0000with\u0001control\u0002bytes',
  'C:\\Windows\\System32',
];

/** Deeply nested JSON string (depth levels) for registry parser stress. */
export function nestedJson(depth: number): string {
  let s = '{"leaf":1}';
  for (let i = 0; i < depth; i++) s = `{"n":${s}}`;
  return s;
}
