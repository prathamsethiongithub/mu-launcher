import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateOfflineUUID } from '../src/main/identity-service';

/**
 * Test 4 — offline UUID generation (identity-service.ts).
 * Expectations are recomputed here with node:crypto as an independent
 * golden reference (MD5 of "OfflinePlayer:" + name, v3 version nibble,
 * RFC-4122 variant bits) — not copied from production code paths.
 */

/** Independent golden implementation of Minecraft's offline UUID scheme. */
function expectedOfflineUUID(name: string): string {
  const hash = createHash('md5').update('OfflinePlayer:' + name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('generateOfflineUUID', () => {
  it.each(['Player', 'Notch', 'Steve'])('matches the golden recomputation for "%s"', (name) => {
    expect(generateOfflineUUID(name)).toBe(expectedOfflineUUID(name));
  });

  it('is stable for the same name', () => {
    expect(generateOfflineUUID('Player')).toBe(generateOfflineUUID('Player'));
    expect(generateOfflineUUID('Player')).toBe(generateOfflineUUID('Player'));
  });

  it('uses UUID v3 version bits (nibble at index 14 === "3")', () => {
    for (const name of ['Player', 'Notch', 'Steve']) {
      expect(generateOfflineUUID(name).charAt(14)).toBe('3');
    }
  });

  it('uses the RFC 4122 variant (nibble at index 19 ∈ {8,9,a,b})', () => {
    for (const name of ['Player', 'Notch', 'Steve']) {
      expect(['8', '9', 'a', 'b']).toContain(generateOfflineUUID(name).charAt(19));
    }
  });

  it('is canonical 8-4-4-4-12 lowercase hex', () => {
    const uuid = generateOfflineUUID('Player');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuid).toBe(uuid.toLowerCase());
  });

  it('different names → different UUIDs', () => {
    const uuids = new Set(['Player', 'player', 'Notch', 'Steve'].map(generateOfflineUUID));
    expect(uuids.size).toBe(4); // case-sensitive: 'Player' ≠ 'player'
  });

  it('differs from the raw MD5 hash (bit surgery is actually applied)', () => {
    const raw = createHash('md5').update('OfflinePlayer:Player').digest('hex');
    const rawFormatted = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    expect(generateOfflineUUID('Player')).not.toBe(rawFormatted);
  });
});
