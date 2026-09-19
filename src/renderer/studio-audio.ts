/**
 * Studio micro-sounds — procedural WebAudio, zero assets, zero dependencies.
 *
 * ⚠️ USER VETO SWITCH: set STUDIO_SOUND_ENABLED to false (or say "音效关掉")
 * to silence the whole thing. Default is ON at floor-level volume:
 *   equip success → warm swell, ≤250 ms, peak gain 0.12
 *   shelf select  → light tick, ≤60 ms, peak gain 0.06
 *
 * An AudioContext can only start after a user gesture; if resume() fails or
 * the context stays suspended, every play call skips silently. These helpers
 * NEVER throw — audio is garnish, and a missing garnish must not crash the
 * studio.
 */

const STUDIO_SOUND_ENABLED = true;

let ctx: AudioContext | null = null;

function getRunningContext(): AudioContext | null {
  if (!STUDIO_SOUND_ENABLED) return null;
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    // Still suspended (no user gesture yet) → stay silent this time.
    if (ctx.state !== 'running') return null;
    return ctx;
  } catch {
    return null;
  }
}

/** Warm equip swell: G3→D4 glide, 250 ms, peak 0.12. */
export function playEquipSwell(): void {
  const ac = getRunningContext();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    gain.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(196, now);
    osc.frequency.exponentialRampToValueAtTime(294, now + 0.2);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.26);

    // A quiet octave-up partial warms the attack without adding volume.
    const partial = ac.createOscillator();
    partial.type = 'triangle';
    partial.frequency.setValueAtTime(392, now);
    const pGain = ac.createGain();
    pGain.gain.setValueAtTime(0.0001, now);
    pGain.gain.linearRampToValueAtTime(0.03, now + 0.03);
    pGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    partial.connect(pGain);
    pGain.connect(ac.destination);
    partial.start(now);
    partial.stop(now + 0.24);
  } catch {
    // never throw for garnish
  }
}

/** Light shelf tick: 880 Hz, 60 ms, peak 0.06. */
export function playSelectTick(): void {
  const ac = getRunningContext();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.06, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    gain.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.07);
  } catch {
    // never throw for garnish
  }
}
