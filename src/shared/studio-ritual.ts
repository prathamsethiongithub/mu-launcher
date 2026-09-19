/**
 * Studio ritual — pure logic for the Identity Studio's euphoria layer.
 *
 * Everything here is side-effect-free so vitest can pin every branch; the
 * IdentityView wires these into localStorage / IPC / the hero.
 *
 * No anxiety mechanics by design: no visit streaks, no counts, no countdowns,
 * no comparisons — the only inputs are "how long since the last visit" and
 * "what the user did".
 */

export type StudioVisitKind = 'pleasure' | 'task' | 'mixed';

/** A Studio visit ≥ 6 h after the previous one earns the Mirror Moment. */
export const STUDIO_ABSENCE_MS = 6 * 60 * 60 * 1000;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Local start-of-day, the boundary "today"/"yesterday" flip on. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "wearing it since …" — lowercase, honest, no precision theatre:
 *   today            → "wearing it since today"
 *   yesterday        → "wearing it since yesterday"
 *   within a week    → "wearing it since tuesday" (the weekday it happened)
 *   older            → "wearing it since sep 5" (local date, mono-friendly)
 * Future timestamps (clock skew) clamp to today.
 */
export function formatWearingSince(ts: number, now: number = Date.now()): string {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (dayDiff <= 0) return 'wearing it since today';
  if (dayDiff === 1) return 'wearing it since yesterday';
  if (dayDiff <= 7) return `wearing it since ${WEEKDAYS[new Date(ts).getDay()]}`;
  const local = new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `wearing it since ${local.toLowerCase()}`;
}

/**
 * The Mirror Moment gate: the user is back after an absence, and this
 * session hasn't greeted them yet.
 *   - No previous visit recorded (first time ever) → not a return; the
 *     wardrobe's own first-skin ritual covers that case instead.
 *   - sessionSeen → this browser session already had its one greeting.
 *   - Exactly 6 h counts as an absence (>=).
 */
export function hasReturnedAfterAbsence(
  lastVisit: number | null,
  now: number,
  sessionSeen: boolean,
): boolean {
  if (lastVisit === null) return false;
  if (sessionSeen) return false;
  return now - lastVisit >= STUDIO_ABSENCE_MS;
}

/**
 * The first-skin ritual fires exactly once per library lifetime: the moment
 * the shelf goes from empty to holding its first skin.
 */
export function isFirstSkin(beforeCount: number, afterCount: number): boolean {
  return beforeCount === 0 && afterCount > 0;
}

/**
 * Pleasure sensor (local-only, never leaves the machine):
 *   'pleasure' — wardrobe play (equip / import / save / rename / re-model),
 *                or a quiet look with no actions at all
 *   'task'     — housekeeping only (delete / reveal)
 *   'mixed'    — both kinds in one visit
 */
export function classifyStudioVisit(actions: string[]): StudioVisitKind {
  const play = new Set(['equip', 'import', 'save-current', 'rename', 'set-model']);
  const task = new Set(['delete', 'reveal']);
  let sawPlay = false;
  let sawTask = false;
  for (const a of actions) {
    if (play.has(a)) sawPlay = true;
    if (task.has(a)) sawTask = true;
  }
  if (sawPlay && sawTask) return 'mixed';
  if (sawPlay) return 'pleasure';
  if (sawTask) return 'task';
  return 'pleasure'; // a quiet look is still the wardrobe doing its job
}

// ── the equip ceremony button ───────────────────────────────────────────────

export type EquipButtonPhase = 'idle' | 'busy' | 'dissolving';

export type EquipButtonKind =
  | { kind: 'wearing' }
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'dissolving' }
  | { kind: 'disabled-offline' }
  | { kind: 'missing' };

/**
 * Four-state machine for the solid amber equip button, pure so vitest pins it.
 *
 *   'wearing'          no button at all: this skin is already on the account
 *                      (fine "wearing it" text renders instead)
 *   'idle'             the solid amber equip button, hover/press alive
 *   'busy'             in-flight: "wearing it now." + pulse, not clickable
 *   'dissolving'       success: the 300 ms fade before the hero reloads
 *   'disabled-offline' offline account: disabled + "requires microsoft"
 *   'missing'          the library file is gone — equip is impossible
 *
 * Precedence (verified against the studio's real flows): a missing file or an
 * in-flight/dissolving request always wins over the trivially-active check —
 * those states describe the REQUEST, not the wardrobe.
 */
export function equipButtonKind(input: {
  previewed: boolean;
  heroMissing: boolean;
  isActiveSkin: boolean;
  canWearCustom: boolean;
  phase: EquipButtonPhase;
}): EquipButtonKind {
  if (!input.previewed) {
    return input.isActiveSkin ? { kind: 'wearing' } : { kind: 'idle' };
  }
  if (input.heroMissing) return { kind: 'missing' };
  if (input.phase === 'dissolving') return { kind: 'dissolving' };
  if (input.phase === 'busy') return { kind: 'busy' };
  if (!input.canWearCustom) return { kind: 'disabled-offline' };
  if (input.isActiveSkin) return { kind: 'wearing' };
  return { kind: 'idle' };
}
