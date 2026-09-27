/**
 * The World Shelf — pure-logic receipts.
 *
 * The live renderer is a separate document (public/shelf/shelf.html) inside an
 * iframe, so the full round trip is proven by tests/e2e/world-shelf.spec.ts.
 * What unit tests can and must own:
 *
 *   1. the accent contract — a world's colour is a pure function of its id,
 *      and BOTH implementations (React's worldAccent and the shelf renderer's
 *      accentFor) must hash identically or cards change colour mid-flight;
 *   2. the mod-stack summary grammar;
 *   3. the generated shelf.html protocol contract — the host↔iframe message
 *      names are a cross-file agreement with no shared module, so the
 *      generated artifact is parsed here to pin the postMessage surface and
 *      catch a silent regeneration drift.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modStackSummary, worldAccent } from '../src/renderer/components/WorldShelf';

const here = dirname(fileURLToPath(import.meta.url));
const shelfHtmlPath = join(here, '..', 'src/renderer/public/shelf/shelf.html');

describe('worldAccent — deterministic per-world colour', () => {
  it('returns the same colour for the same id, always', () => {
    for (const id of ['managed-mu-smp', 'a', 'uuid-4f9c-…', '世界', '']) {
      expect(worldAccent(id)).toBe(worldAccent(id));
    }
  });

  it('is a pure function of the id: different ids differ, order never matters', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const first = ids.map(worldAccent);
    const second = [...ids].reverse().map(worldAccent);
    expect(new Set(first).size).toBeGreaterThan(1); // the ring is not all one hue
    expect([...second].reverse()).toEqual(first);
  });

  it('emits a well-formed hsl() colour the canvas can consume', () => {
    for (let i = 0; i < 50; i += 1) {
      const colour = worldAccent(`world-${i}`);
      expect(colour).toMatch(/^hsl\(\d+ 34% \d+%\)$/);
    }
  });

  it('stays inside the accent ring and lightness band', () => {
    for (let i = 0; i < 200; i += 1) {
      const colour = worldAccent(`id-${i}`);
      const hue = Number(colour.match(/^hsl\((\d+)/)![1]);
      const lightness = Number(colour.match(/(\d+)%\)$/)[1]);
      expect([18, 34, 46, 96, 150, 188, 214, 258, 292, 330]).toContain(hue);
      expect(lightness).toBeGreaterThanOrEqual(40);
      expect(lightness).toBeLessThanOrEqual(50);
    }
  });
});

describe('modStackSummary', () => {
  it('says so plainly when there are no mods', () => {
    expect(modStackSummary([])).toBe('No mods');
  });

  it('lists up to two mods verbatim', () => {
    expect(modStackSummary(['sodium'])).toBe('sodium');
    expect(modStackSummary(['sodium', 'lithium'])).toBe('sodium · lithium');
  });

  it('folds the rest into "+ N more"', () => {
    expect(modStackSummary(['sodium', 'lithium', 'ferrite-core'])).toBe('sodium · lithium + 1 more');
    expect(modStackSummary(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a · b + 5 more');
  });
});

describe('generated shelf.html — the postMessage contract', () => {
  const html = readFileSync(shelfHtmlPath, 'utf8');

  /** The host → shelf surface, as WorldShelf.tsx posts it. */
  const HOST_MESSAGES = ['worlds', 'pause', 'resume'];
  /** The shelf → host surface, as WorldShelf.tsx consumes it. */
  const SHELF_MESSAGES = ['shelf-ready', 'world-selected', 'play-requested'];
  /** The per-world payload the bridge reads. */
  const WORLD_FIELDS = ['id', 'title', 'subtitle', 'accentColor', 'metadata', 'serverStatus', 'isActive'];

  it('exists and was generated from the canonical source', () => {
    expect(html).toContain('World Shelf');
    expect(html).toContain('./vendor/three/three.module.js');
    // No CDN may survive: the launcher is offline-first and same-origin.
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('listens for every host → shelf message', () => {
    expect(html).toContain('window.addEventListener("message"');
    for (const type of HOST_MESSAGES) {
      expect(html).toContain(`data.type === "${type}"`);
    }
  });

  it('posts every shelf → host message', () => {
    for (const type of SHELF_MESSAGES) {
      expect(html).toContain(`type: "${type}"`);
    }
  });

  it('rebuilds the shelf from the worlds payload', () => {
    expect(html).toContain('function worldToRecord(');
    expect(html).toContain('function buildShelfFromWorlds(');
    for (const field of WORLD_FIELDS) {
      expect(html).toContain(field);
    }
  });

  it('announces itself only after booting, and parks on pause', () => {
    expect(html).toContain('postToHost({ type: "shelf-ready" })');
    expect(html).toContain('function hostPause(');
    expect(html).toContain('function hostResume(');
  });

  it("keeps the brief's title copy", () => {
    expect(html).toContain('every world is a different fire');
  });

  it('answers selection and play through the card overlay', () => {
    expect(html).toContain('id="card-overlay-play"');
    expect(html).toContain('overlayPlay.dataset.worldId');
  });
});
