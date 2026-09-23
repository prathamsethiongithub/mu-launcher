/**
 * Persona 3 — mod-hoarder: the collector whose library outgrew the UI.
 *
 * Seeds 150 skin entries — realistic variants: 10-char and 40-char names
 * (the sanitize cap), exact duplicate names (sort/dedupe stress), and 5
 * entries whose PNG file is missing (the "missing" card path) — plus 3
 * worlds and the default offline account.
 *
 * The contract: the shelf renders fast enough to not feel dead (per-card
 * wall-clock from 'your library' visible to card count stable < 5s under
 * 4× CPU — the launch itself is outside the budget), horizontal scroll
 * actually reaches the far end, the law holds at every size, and the equip
 * gate is HONEST for an offline account ("requires microsoft", never a
 * fake enabled button).
 *
 * Equip limitation (recorded for the truth doc): a REAL equip round-trip
 * needs a Microsoft session whose tokens live in safeStorage-encrypted
 * identity-tokens.bin — not deterministically seedable. The honest-gate
 * assertion is the deterministic portion; the network round-trip is
 * covered by the flaky-network persona's skin-failure path instead.
 */

import { launchTestApp, clickButtonByText, type TestApp } from '../harness';
import { buildSkinPng, seedSkins, seedWorlds, throttleCpu } from './lib';
import { LAYOUT_AUDIT } from '../layout-audit';

export const id = 'mod-hoarder';
export const description =
  '库外溢的用户：150 个皮肤（长短名/重名/缺文件）+ 3 个世界。' +
  '预期：渲染不卡死、横向滚动可达、布局法则成立、equip 门控诚实。';

let ta: TestApp;
let cdp: Awaited<ReturnType<typeof throttleCpu>> | null = null;

export async function run(): Promise<void> {
  const skins = [];
  for (let i = 0; i < 145; i++) {
    const isLong = i % 15 === 0;
    const isDup = i % 7 === 3;
    skins.push({
      id: `e2e-skin-${String(i).padStart(3, '0')}`,
      // rotate shades so every head crop differs (no dedupe shortcut)
      png: buildSkinPng((i * 37) % 256),
      name: isLong
        ? `skin-with-an-extremely-long-name-${String(i).padStart(3, '0')}-beyond-40-chars`
        : isDup
          ? 'the same name'
          : `hoard ${i}`,
      model: i % 3 === 0 ? ('slim' as const) : ('classic' as const),
    });
  }
  // 5 missing-file variants (registry entry, no PNG on disk).
  for (let i = 145; i < 150; i++) {
    skins.push({ id: `e2e-skin-missing-${i}`, name: `ghost ${i}` });
  }

  const seed = (dir: string): void => {
    seedSkins(dir, skins);
    seedWorlds(dir, [
      { id: 'managed-mu-smp', name: "Masters' Union SMP", type: 'managed' },
      { id: 'e2e-world-1', name: 'atelier' },
      { id: 'e2e-world-2', name: 'wanderfall' },
    ]);
  };

  ta = await launchTestApp({ seed });
  cdp = await throttleCpu(ta.app, 4); // hoarder also on mid hardware

  await clickButtonByText(ta.window, 'Account');
  await ta.window.waitForTimeout(1_000);

  // ── Render timing: from shelf visible to all 150 cards stable < 5s ──
  const timing = await ta.window.evaluate(async () => {
    const t0 = performance.now();
    const deadline = t0 + 15_000;
    let stable = -1;
    let prev = -1;
    let sinceChange = 0;
    while (performance.now() < deadline) {
      const n = document.querySelectorAll('div.w-\\[104px\\]').length;
      if (n === prev) {
        sinceChange += 150;
        if (sinceChange >= 450 && n > 0) { stable = n; break; }
      } else {
        sinceChange = 0;
        prev = n;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { count: stable, elapsedMs: performance.now() - t0 };
  });
  if (timing.count !== 150) {
    const body = await ta.window.evaluate(() => document.body.innerText.slice(0, 200));
    throw new Error(`shelf card count ${timing.count} !== 150. body head: ${body}`);
  }
  if (timing.elapsedMs > 5_000) {
    throw new Error(`shelf took ${Math.round(timing.elapsedMs)}ms to stabilize (budget 5000ms @ CPU 4×)`);
  }

  // ── Horizontal scroll reaches the far end (last card + add-a-skin) ──
  const scroll = await ta.window.evaluate(() => {
    const rail = [...document.querySelectorAll('div')].find(
      (d) => d.className.includes('overflow-x-auto'),
    );
    if (!rail) return { ok: false, why: 'rail not found' };
    rail.scrollLeft = rail.scrollWidth;
    return new Promise<{ ok: boolean; why?: string; maxLeft?: number }>((resolve) =>
      setTimeout(() => {
        const addBtn = [...rail.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('add a skin'),
        );
        resolve({
          ok: !!addBtn,
          why: addBtn ? undefined : 'add-a-skin not reachable at scroll end',
          maxLeft: rail.scrollLeft,
        });
      }, 400),
    );
  });
  if (!scroll.ok) throw new Error(`horizontal scroll: ${scroll.why}`);

  // ── Equip gate honesty: offline account → disabled + "requires microsoft" ──
  // Click the first card to preview it, then inspect the equip row.
  const gate = await ta.window.evaluate(async () => {
    const rail = [...document.querySelectorAll('div')].find(
      (d) => d.className.includes('overflow-x-auto'),
    );
    const card = rail?.querySelector('div.w-\\[104px\\]') as HTMLElement | undefined;
    if (!card) return { ok: false, why: 'no card to preview' };
    card.click();
    await new Promise((r) => setTimeout(r, 600));
    const body = document.body.innerText;
    const equipBtn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'equip',
    );
    return {
      ok: true,
      equipVisible: !!equipBtn,
      disabled: equipBtn ? equipBtn.disabled : null,
      requiresMs: body.includes('requires microsoft'),
    };
  });
  if (!gate.ok) throw new Error(`equip gate probe failed: ${gate.why}`);
  if (!gate.equipVisible || gate.disabled !== true || !gate.requiresMs) {
    throw new Error(
      `offline equip gate dishonest: visible=${gate.equipVisible} disabled=${gate.disabled} ` +
        `requiresMs=${gate.requiresMs}`,
    );
  }

  // ── The layout law at full shelf width ──
  const problems = await ta.window.evaluate(LAYOUT_AUDIT);
  if (problems.problems.length > 0) {
    // Evidence dump: rects + hit chains so a fix is geometric, not guessed.
    const evidence = await ta.window.evaluate(() => {
      const dump = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return `${el.tagName}.${(el.className + '').slice(0, 40)} [${Math.round(r.left)},${Math.round(r.top)}→${Math.round(r.right)},${Math.round(r.bottom)}]`;
      };
      const equip = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'equip' || b.textContent?.trim() === 'wearing it now.',
      );
      const chain: (string | null)[] = [];
      if (equip) {
        const r = equip.getBoundingClientRect();
        let hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        for (let i = 0; i < 5 && hit; i++) { chain.push(dump(hit)); hit = hit.parentElement; }
      }
      return { equip: dump(equip), hitChain: chain, canvases: [...document.querySelectorAll('canvas')].map(dump) };
    });
    throw new Error(
      `layout violations on hoarder shelf: ${JSON.stringify(problems.problems.slice(0, 8))}\n` +
        `evidence: ${JSON.stringify(evidence)}`,
    );
  }
}

export async function teardown(): Promise<void> {
  try {
    await cdp?.detach();
  } catch { /* */ }
  cdp = null;
  if (ta) await ta.cleanup();
}

