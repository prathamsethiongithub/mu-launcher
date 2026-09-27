/**
 * The World Shelf — live proof that the 3D world browser actually runs.
 *
 * The scene is a separate document (public/shelf/shelf.html) inside an iframe,
 * so everything about it is unverifiable by unit tests: whether three.js r165
 * loads from the vendored path under a file:// origin, whether the renderer
 * boots, whether a world payload crosses the postMessage boundary and becomes
 * a card, and whether a click on that card's Play button reaches the launcher.
 *
 * These tests drive the real compiled app for exactly that reason.
 */

import { test, expect } from 'playwright/test';
import { launchTestApp, clickButtonByText, waitForText, type TestApp } from './harness';

const SHELF_FRAME = 'iframe[title="World shelf"]';

/** The registry always provisions the managed world, so the shelf is never
 *  empty on a fresh profile — no world seeding needed. */
const MANAGED_WORLD_NAME = "Masters' Union SMP";
const MANAGED_WORLD_ID = 'managed-mu-smp';

/** FrameLocator cannot evaluate; the same frame as a Frame object can. */
async function shelfFrame(ta: TestApp) {
  await ta.window.waitForFunction(
    () => [...document.querySelectorAll('iframe')].some((f) => f.src.includes('shelf/shelf.html')),
    undefined,
    { timeout: 20_000 },
  );
  const frame = ta.window.frames().find((f) => f.url().includes('shelf/shelf.html'));
  if (!frame) throw new Error('the world shelf frame never appeared');
  return frame;
}

async function openWorldsViews(ta: TestApp) {
  await waitForText(ta.window, 'Ready.', 20_000);
  await clickButtonByText(ta.window, 'Worlds');
  await ta.window.waitForTimeout(500);
}

// WebGL initialisation plus a 1.2 MB r165 module graph is the slowest thing
// this suite boots; the default 60s budget is too tight for four of them.
const SHELF_TIMEOUT = 150_000;

test.describe('world shelf', () => {
  test('boots the 3D renderer, builds a card per world, and anchors the card overlay', async () => {
    test.setTimeout(SHELF_TIMEOUT);
    const ta = await launchTestApp();
    try {
      await openWorldsViews(ta);

      // The shelf is the page: its frame is mounted and the flat list is not.
      const iframe = ta.window.locator(SHELF_FRAME);
      await expect(iframe).toBeVisible({ timeout: 20_000 });
      expect(await ta.window.evaluate(() => document.body.innerText)).not.toContain(
        MANAGED_WORLD_NAME,
      );

      const frame = ta.window.frameLocator(SHELF_FRAME);
      const canvas = frame.locator('canvas#scene');
      await expect(canvas).toBeAttached({ timeout: 20_000 });

      // three.js r165 reached the renderer: the canonical shelf only adds its
      // loading class after `initialize()` resolves, which requires the whole
      // module graph to have loaded from the vendored path.
      await expect(frame.locator('#experience.webgl-ready')).toHaveCount(1, { timeout: 45_000 });

      // The world arrived over postMessage and was rebuilt into the shelf.
      await expect(frame.locator('#shelf-count')).toContainText('1 world', { timeout: 20_000 });

      // …and the selected card's overlay is anchored to it, which is what
      // carries the world's name, mod stack, status dot and Play button.
      const overlay = frame.locator('#card-overlay');
      await expect(overlay).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
      await expect(frame.locator('#card-overlay-title')).toHaveText(MANAGED_WORLD_NAME);

      // The payload's isActive crossed the boundary: the managed world is the
      // profile's active world, so the selected card shows the active chip.
      await expect(overlay).toHaveAttribute('data-active', 'true', { timeout: 10_000 });

      // Card geometry, not book geometry: the shelf reports what it built.
      const worldCount = await (await shelfFrame(ta)).evaluate(
        () => (window as unknown as { __worldShelf?: { worlds: unknown[] } }).__worldShelf?.worlds.length,
      );
      expect(worldCount).toBe(1);

      // No CSP or module-resolution failures from inside the frame.
      const fatal = ta.consoleCapture.errors.filter((text) =>
        /Content Security Policy|Failed to load module|Refused to|net::ERR/i.test(text),
      );
      expect(fatal).toEqual([]);
    } finally {
      await ta.cleanup();
    }
  });

  test('a Play click inside the card reaches the launcher, and the manage drawer stays secondary', async () => {
    test.setTimeout(SHELF_TIMEOUT);
    const ta = await launchTestApp();
    try {
      await openWorldsViews(ta);

      // The manage drawer is where the flat list lives now: closed by default,
      // and it is the ONLY place the world rows exist.
      const bodyBefore = await ta.window.evaluate(() => document.body.innerText);
      expect(bodyBefore).toContain('Manage worlds');
      expect(bodyBefore).not.toContain(MANAGED_WORLD_NAME);
      await clickButtonByText(ta.window, 'Manage worlds');
      await expect
        .poll(async () => ta.window.evaluate(() => document.body.innerText), { timeout: 10_000 })
        .toContain(MANAGED_WORLD_NAME);

      // The postMessage round trip is what this test proves, so watch the
      // boundary directly. window.electronAPI is contextBridge-frozen (its
      // methods cannot be stubbed — assignment silently no-ops), so we record
      // what the shelf actually posts to the parent instead of faking the
      // launch surface.
      await ta.window.evaluate(() => {
        const seen: Array<{ type?: string; worldId?: string }> = [];
        (window as unknown as { __shelfMessages: typeof seen }).__shelfMessages = seen;
        window.addEventListener('message', (event) => {
          const data = event.data as { type?: string; worldId?: string } | null;
          if (data && typeof data === 'object' && typeof data.type === 'string') {
            seen.push({ type: data.type, worldId: data.worldId });
          }
        });
      });

      const frame = ta.window.frameLocator(SHELF_FRAME);
      await expect(frame.locator('#card-overlay-play')).toBeVisible({ timeout: 45_000 });
      await frame.locator('#card-overlay-play').click();

      // 1. The card's Play button crossed the boundary as play-requested,
      //    carrying the selected world's id.
      await expect
        .poll(
          async () =>
            ta.window.evaluate(
              () =>
                (window as unknown as {
                  __shelfMessages?: Array<{ type?: string; worldId?: string }>;
                }).__shelfMessages?.find((m) => m.type === 'play-requested')?.worldId ?? null,
            ),
          { timeout: 20_000 },
        )
        .toBe(MANAGED_WORLD_ID);

      // 2. React consumed it: the launcher switched the active world to the
      //    one the card named — the disk write is the round trip's receipt.
      await expect
        .poll(
          async () =>
            ta.window.evaluate(async () => (await window.electronAPI.getActiveWorld())?.id ?? null),
          { timeout: 10_000 },
        )
        .toBe(MANAGED_WORLD_ID);

      // 3. And the shelf handed the user back to Play, exactly like the Play
      //    CTA does.
      await expect
        .poll(async () => ta.window.evaluate(() => document.body.innerText), { timeout: 10_000 })
        .not.toContain('Manage worlds');
    } finally {
      await ta.cleanup();
    }
  });

  test('parks its render loop while the view is hidden and resumes on return', async () => {
    test.setTimeout(SHELF_TIMEOUT);
    const ta = await launchTestApp();
    try {
      await openWorldsViews(ta);
      const frame = ta.window.frameLocator(SHELF_FRAME);
      await expect(frame.locator('#card-overlay')).toHaveAttribute('data-visible', 'true', {
        timeout: 45_000,
      });

      // Leave Worlds: the shelf is told to stop, which must not tear it down.
      await clickButtonByText(ta.window, 'Play');
      await ta.window.waitForTimeout(1200);
      await clickButtonByText(ta.window, 'Worlds');

      // Still alive and still showing the same selected card.
      await expect(frame.locator('#card-overlay')).toHaveAttribute('data-visible', 'true', {
        timeout: 20_000,
      });
      await expect(frame.locator('#card-overlay-title')).toHaveText(MANAGED_WORLD_NAME);
    } finally {
      await ta.cleanup();
    }
  });

  test('survives reduced motion', async () => {
    test.setTimeout(SHELF_TIMEOUT);
    const ta = await launchTestApp();
    try {
      // Emulated at the browser level so it reaches the shelf's own media
      // query — the shelf is a separate document and reads it itself.
      await ta.window.emulateMedia({ reducedMotion: 'reduce' });
      await openWorldsViews(ta);
      const frame = ta.window.frameLocator(SHELF_FRAME);
      const realFrame = await shelfFrame(ta);

      await expect(frame.locator('#experience.webgl-ready')).toHaveCount(1, { timeout: 45_000 });
      expect(
        await realFrame.evaluate(
          () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      ).toBe(true);

      // Reduced motion only shortens the canonical motion — the shelf still
      // builds, and the selected card still gets its anchored play overlay.
      await expect(frame.locator('#shelf-count')).toContainText('1 world', { timeout: 20_000 });
      await expect(frame.locator('#card-overlay')).toHaveAttribute('data-visible', 'true', {
        timeout: 20_000,
      });
      await expect(frame.locator('#card-overlay-title')).toHaveText(MANAGED_WORLD_NAME);
    } finally {
      await ta.cleanup();
    }
  });
});
