import React, { useState, useEffect, useCallback, useRef } from 'react';
import SkinViewerCanvas from './fx/SkinViewerCanvas';
import { playEquipSwell, playSelectTick } from '../studio-audio';
import {
  classifyStudioVisit,
  equipButtonKind,
  formatWearingSince,
  hasReturnedAfterAbsence,
  isFirstSkin,
} from '../../shared/studio-ritual';
import {
  equipButtonPhase,
  equipCeremonyNext,
  resolutionLadder,
  shouldSkipMaterialize,
  EQUIP_LADDER,
  EQUIP_MATERIALIZE_BUDGET,
  IMPORT_LADDER,
  IMPORT_MATERIALIZE_BUDGET,
  SKIP_SAMPLE_WINDOW_MS,
  type CeremonyEvent,
  type CeremonyPhase,
  type MaterializeVariant,
} from '../../shared/materialize';
import { resolveWornSkin } from '../../shared/worn-skin';

/**
 * Identity Studio — the player's private skin wardrobe.
 *
 * Layering (per the rework brief): account strip (one quiet row) → the hero
 * (the live character + "same game. different you.") → the skin shelf
 * (horizontal cards: import / rename / equip / delete / reveal).
 *
 * Honesty rules: equip is a network operation and always shows its true state
 * (in-flight / "wearing it now." / "couldn't reach mojang. nothing changed.");
 * the "active" mark appears ONLY when the account's worn-skin hash matches a
 * library entry — never guessed; offline accounts can't wear custom skins and
 * the UI says why instead of pretending.
 */

interface AccountData {
  id: string;
  type: 'microsoft' | 'offline';
  username: string;
  uuid?: string;
  createdAt: string;
  lastUsedAt?: string;
  hasSession?: boolean;
}

interface SkinEntry {
  id: string;
  name: string;
  fileName: string;
  model: 'classic' | 'slim';
  addedAt: string;
  lastEquippedAt?: string;
  hash: string;
  /** data URL of the PNG (null → the file is missing — the "missing" card). */
  dataUrl: string | null;
}

/** An active resolution materialization; null = the hero is at full scale. */
interface MaterializeSpec {
  variant: MaterializeVariant;
  skinId: string;
  /** import only: this birth was the wardrobe's first skin (existing ritual owns the message). */
  announceFirst: boolean;
}

const toViewerModel = (variant: 'classic' | 'slim'): 'default' | 'slim' =>
  variant === 'slim' ? 'slim' : 'default';

const DRAG_HINT_KEY = 'identity-studio-drag-hint-done';
const VISIT_KEY = 'identity-studio-last-visit';
const VISIT_LOG_KEY = 'identity-studio-visit-log';
/** Stage 1 module-session flag — the Mirror Moment fires once per app run. */
let mirrorShownThisSession = false;

/** 2D head crop for shelf cards — canvas 2D, never a three.js instance. */
const SkinHead: React.FC<{ dataUrl: string | null; size?: number }> = ({ dataUrl, size = 56 }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !dataUrl) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Face region of the head: (8,8)-(16,16) on both 64×64 and 64×32 layouts.
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    };
    img.src = dataUrl;
  }, [dataUrl]);
  if (!dataUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-[4px] border border-line text-[10px] text-faint"
        style={{ width: size, height: size }}
      >
        missing
      </div>
    );
  }
  return <canvas ref={ref} width={size} height={size} className="rounded-[4px]" style={{ width: size, height: size }} />;
};

const IdentityView: React.FC = () => {
  // ── accounts (the quiet strip) ────────────────────────────────────────
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showOfflineDialog, setShowOfflineDialog] = useState(false);
  const [offlineName, setOfflineName] = useState('');
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [msLoading, setMsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // ── the wardrobe ──────────────────────────────────────────────────────
  const [skins, setSkins] = useState<SkinEntry[]>([]);
  const [skinsLoading, setSkinsLoading] = useState(true);
  const [wearingHash, setWearingHash] = useState<string | null>(null);
  /** The account's worn texture, resolved cache-first through 'get-identity-skin'. */
  const [wornSkin, setWornSkin] = useState<{ dataUrl: string; model: 'classic' | 'slim' } | null>(null);
  /** False until the current account's worn-texture resolve has settled. */
  const [wornSkinReady, setWornSkinReady] = useState(false);
  /** Which entry the hero is previewing; null = the account's own skin. */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [equip, setEquip] = useState<{ id: string; phase: CeremonyPhase; msg: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [duplicateMsg, setDuplicateMsg] = useState<string | null>(null);
  const [showDragHint, setShowDragHint] = useState(false);
  // ── euphoria stage 1 ──────────────────────────────────────────────────
  const [mirrorEpoch, setMirrorEpoch] = useState(0); // remount → GREETING wave
  const [mirrorLine, setMirrorLine] = useState<string | null>(null);
  const [firstSkinMsg, setFirstSkinMsg] = useState<string | null>(null);
  const [firstInId, setFirstInId] = useState<string | null>(null);
  /** The 200 ms red flash on failure. */
  const [failFlash, setFailFlash] = useState(false);
  /** Resolution materialization (equip morph ladder / import reveal ladder).
   *  v2: the character itself starts at a low resolution and climbs — the v1
   *  texture-atlas curtain was rejected in user acceptance. */
  const [materialize, setMaterialize] = useState<MaterializeSpec | null>(null);
  /** The hero's current ladder rung; 1 = full resolution. */
  const [materializeScale, setMaterializeScale] = useState(1);
  /** Latest spec, readable synchronously inside event handlers. */
  const materializeRef = useRef<MaterializeSpec | null>(null);
  materializeRef.current = materialize;
  /** Pleasure sensor: actions recorded this visit, classified on unmount. */
  const sensorActionsRef = useRef<string[]>([]);

  const activeAccount = accounts.find((a) => a.id === activeAccountId);
  const isMsActive = activeAccount?.type === 'microsoft';
  const isOfflineActive = activeAccount?.type === 'offline';
  const isSignedOut = isMsActive && activeAccount?.hasSession === false;
  const canWearCustom = !!isMsActive && !isSignedOut;

  const previewed = previewId ? skins.find((s) => s.id === previewId) ?? null : null;

  const loadAccounts = useCallback(async () => {
    try {
      const accts = await window.electronAPI.getAccounts() as AccountData[];
      setAccounts(accts);
      const active = await window.electronAPI.getActiveAccount() as AccountData | null;
      setActiveAccountId(active?.id || null);
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSkins = useCallback(async (): Promise<SkinEntry[]> => {
    setSkinsLoading(true);
    try {
      const result = await window.electronAPI.skinsList();
      const list = result.skins ?? [];
      setSkins(list);
      return list;
    } catch {
      setSkins([]);
      return [];
    } finally {
      setSkinsLoading(false);
    }
  }, []);

  // The honest "active" check: hash of what the account is actually wearing,
  // resolved through the existing skin-service path. Never guessed.
  const loadWearingHash = useCallback(async (accountId: string | null) => {
    if (!accountId) { setWearingHash(null); return; }
    try {
      const r = await window.electronAPI.skinsWearingHash(accountId);
      setWearingHash(r.hash);
    } catch {
      setWearingHash(null);
    }
  }, []);

  // The worn TEXTURE — read through the existing 'get-identity-skin' channel
  // (identity-service → skin-service, 24h cache). No new IPC: the channel
  // existed, the Studio just never consumed it (the §5.2 gap). Must run AFTER
  // loadWearingHash (see loadWornState): the hash's force-fetch writes
  // through to the cache, so this cache-first read returns exactly the bytes
  // the hash names.
  const loadWornSkin = useCallback(async (accountId: string | null) => {
    if (!accountId) { setWornSkin(null); setWornSkinReady(true); return; }
    try {
      const profile = await window.electronAPI.getIdentitySkin(accountId);
      setWornSkin(profile?.skinUrl ? { dataUrl: profile.skinUrl, model: profile.model } : null);
    } catch {
      setWornSkin(null);
    } finally {
      setWornSkinReady(true);
    }
  }, []);

  /** hash first (force-fetch writes through), then the cache-first texture read. */
  const loadWornState = useCallback(async (accountId: string | null) => {
    await loadWearingHash(accountId);
    await loadWornSkin(accountId);
  }, [loadWearingHash, loadWornSkin]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  useEffect(() => {
    window.electronAPI.onAuthChanged(() => { loadAccounts(); });
    return () => window.electronAPI.removeAuthChangedListeners();
  }, [loadAccounts]);

  // Account switch → re-read wardrobe + wearing state. Preview resets to the
  // account skin (previewing someone else's pick across a switch is a lie).
  useEffect(() => {
    setPreviewId(null);
    setEquip(null);
    setDuplicateMsg(null);
    // Stale wearing/texture state would flash the previous account's skin.
    setWearingHash(null);
    setWornSkin(null);
    setWornSkinReady(false);
    loadSkins();
    loadWornState(activeAccountId);
  }, [activeAccountId, loadSkins, loadWornState]);

  // Drag-rotate hint: shown once per machine, gone after the first drag.
  useEffect(() => {
    try { setShowDragHint(!localStorage.getItem(DRAG_HINT_KEY)); } catch { setShowDragHint(false); }
  }, []);

  // ── Mirror Moment + visit bookkeeping (Stage 1) ───────────────────────
  // Runs once per mount: gate the greeting on the pure function, stamp the
  // visit, and leave the sensor to classify on unmount.
  useEffect(() => {
    const now = Date.now();
    let last: number | null = null;
    try {
      const raw = localStorage.getItem(VISIT_KEY);
      const parsed = raw === null ? NaN : Number(raw);
      last = Number.isNaN(parsed) ? null : parsed;
    } catch {
      last = null;
    }
    if (hasReturnedAfterAbsence(last, now, mirrorShownThisSession)) {
      mirrorShownThisSession = true;
      setMirrorEpoch((e) => e + 1); // remount hero → the same GREETING wave equip uses
      setMirrorLine(`hey, ${activeAccount?.username.toLowerCase() ?? 'you'}.`);
      setTimeout(() => setMirrorLine(null), 5000);
    }
    try { localStorage.setItem(VISIT_KEY, String(now)); } catch { /* private mode */ }
    // The pleasure sensor: classify this visit's actions and file it locally.
    const actions = sensorActionsRef.current;
    return () => {
      try {
        const log = JSON.parse(localStorage.getItem(VISIT_LOG_KEY) ?? '[]') as
          { ts: number; kind: string }[];
        log.push({ ts: Date.now(), kind: classifyStudioVisit(actions) });
        localStorage.setItem(VISIT_LOG_KEY, JSON.stringify(log.slice(-200)));
      } catch { /* never let the sensor break the studio */ }
      actions.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recordAction = useCallback((action: string) => {
    sensorActionsRef.current.push(action);
  }, []);
  const handleOrbitStart = useCallback(() => {
    setShowDragHint(false);
    try { localStorage.setItem(DRAG_HINT_KEY, '1'); } catch { /* private mode */ }
  }, []);

  // ── account actions (unchanged behaviour, quieter presentation) ───────
  const handleAddMicrosoft = async () => {
    setMsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.addMicrosoftAccount();
      if (!result.success) setError(result.error || 'Sign-in didn’t complete. Try again.');
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in didn’t complete. Try again.');
    } finally {
      setMsLoading(false);
    }
  };

  const handleAddOffline = async () => {
    if (!offlineName.trim()) { setOfflineError('Username cannot be empty.'); return; }
    setActionLoading('offline');
    setOfflineError(null);
    try {
      const result = await window.electronAPI.addOfflineAccount(offlineName);
      if (!result.success) {
        setOfflineError(result.error || 'Failed to create offline account.');
        return;
      }
      setShowOfflineDialog(false);
      setOfflineName('');
      await loadAccounts();
    } finally {
      setActionLoading(null);
    }
  };

  const handleSignOut = async (accountId: string) => {
    setActionLoading(accountId);
    try {
      const result = await window.electronAPI.signOutAccount(accountId);
      if (!result.success) setError(result.error || 'Sign-out failed.');
      await loadAccounts();
      await loadWornState(activeAccountId);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    setActionLoading(accountId);
    setConfirmRemoveId(null);
    try {
      const result = await window.electronAPI.removeAccount(accountId);
      if (!result.success) setError(result.error || 'Failed to remove account.');
      await loadAccounts();
      await loadWornState(activeAccountId);
    } catch {
      setError('Failed to remove account. Please try again.');
    } finally {
      setActionLoading(null);
    }
  };

  // ── wardrobe actions ──────────────────────────────────────────────────
  const refreshWardrobe = useCallback(async (): Promise<SkinEntry[]> => {
    const list = await loadSkins();
    await loadWearingHash(activeAccountId);
    return list;
  }, [loadSkins, loadWornState, activeAccountId]);

  const handleAddSkin = async () => {
    setDuplicateMsg(null);
    const chosen = await window.electronAPI.selectSkinFile();
    if (!chosen) return; // dialog canceled
    if ('error' in chosen) {
      setDuplicateMsg(chosen.error);
      return;
    }
    // The chosen path is held in the main process — import consumes it there.
    const beforeCount = skins.length;
    const result = await window.electronAPI.skinsImport();
    if (!result.success) {
      setDuplicateMsg(result.error || 'Could not add that skin.');
      return;
    }
    const list = await loadSkins(); // the refreshed list is the single data source
    recordAction('import');
    if (result.duplicate && result.message) {
      setDuplicateMsg(result.message);
      return;
    }
    if (result.skin) {
      setDuplicateMsg(null);
      announceIfFirstSkin(beforeCount, result.skin);
      const revealing = startImportMaterialize(list, result.skin.id, beforeCount);
      if (!revealing) setPreviewId(result.skin.id); // no texture → no ceremony
    }
  };

  const handleSaveCurrent = async () => {
    if (!activeAccountId) return;
    setDuplicateMsg(null);
    const beforeCount = skins.length;
    const result = await window.electronAPI.skinsSaveCurrent(activeAccountId);
    if (!result.success) {
      setDuplicateMsg(result.error || 'Could not save that skin.');
      return;
    }
    const list = await refreshWardrobe(); // the refreshed list is the single data source
    recordAction('save-current');
    if (result.duplicate && result.message) setDuplicateMsg(result.message);
    if (result.skin) {
      announceIfFirstSkin(beforeCount, result.skin);
      const revealing = startImportMaterialize(list, result.skin.id, beforeCount);
      if (!revealing) setPreviewId(result.skin.id); // no texture → no ceremony
    }
  };

  /** The first-skin ritual: 0 → 1 deserves a greeting and a springy card. */
  const announceIfFirstSkin = (beforeCount: number, skin: { id: string }) => {
    const afterCount = beforeCount + 1;
    if (!isFirstSkin(beforeCount, afterCount)) return;
    setFirstSkinMsg('saved. first of many.');
    setMirrorEpoch((e) => e + 1); // the same GREETING wave, via the public reload path
    // Springy entrance: mount the card hidden, flip on the next painted frame
    // so the 120ms/300ms transitions actually animate from scale-95/opacity-0.
    setFirstInId(skin.id);
    requestAnimationFrame(() => requestAnimationFrame(() => setFirstInId(null)));
  };

  // ── resolution materialization (equip morph + import reveal) ──────────
  // v2 (after v1's pixel curtain was rejected in acceptance): the character
  // ITSELF materializes — SkinViewerCanvas renders at a discrete low
  // resolution and climbs rung by rung to full. The atlas is never shown.

  /** All ceremony transitions pass through the pure machine. */
  const dispatchCeremony = useCallback((event: CeremonyEvent) => {
    setEquip((cur) => {
      if (!cur) return cur;
      const next = equipCeremonyNext(cur.phase, event);
      return next === 'done' ? null : { ...cur, phase: next };
    });
  }, []);

  /** Settle any in-flight materialization to its end state — never two at once. */
  const finalizeActiveMaterialize = useCallback(() => {
    const cur = materializeRef.current;
    if (!cur) return;
    if (cur.variant === 'import' && !cur.announceFirst) setFirstSkinMsg('saved.');
    setMaterializeScale(1);
    setMaterialize(null);
    dispatchCeremony({ type: 'MATERIALIZE_END' });
  }, [dispatchCeremony]);

  /**
   * The ladder loop. Runs while a materialization is active; complete, skip
   * (click anywhere), reduced motion and the fps guard all land on the SAME
   * terminal state: scale 1, no second animation. The swap window is the
   * start itself — the hero remount happens in the same batch as the
   * ceremony start (equip success / import success), so the character's
   * first visible frame is already at the first rung and the GREETING wave
   * plays while the climb runs.
   */
  useEffect(() => {
    if (!materialize) return;
    let finished = false;
    let raf = 0;
    let start = 0;
    let lastFrame = 0;
    const samples: number[] = [];
    let fpsDecided = false;
    const budget =
      materialize.variant === 'equip' ? EQUIP_MATERIALIZE_BUDGET : IMPORT_MATERIALIZE_BUDGET;

    const finish = (viaSkip: boolean) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      if (materialize.variant === 'import' && !materialize.announceFirst) setFirstSkinMsg('saved.');
      setMaterializeScale(1);
      setMaterialize(null);
      dispatchCeremony({ type: 'MATERIALIZE_END' });
    };

    // Click anywhere during the climb → jump straight to scale 1.
    const onSkipClick = () => finish(true);
    window.addEventListener('click', onSkipClick, true);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      finish(false); // no ladder → full resolution immediately
      window.removeEventListener('click', onSkipClick, true);
      return;
    }

    setMaterializeScale(materialize.variant === 'equip' ? EQUIP_LADDER[0] : IMPORT_LADDER[0]);
    const tick = (now: number) => {
      if (finished) return;
      if (start === 0) {
        start = now;
        lastFrame = now;
      }
      const elapsed = now - start;
      // fps guard: sample the first 200ms, decide once; ≥3 samples with a
      // median interval >50ms → abandon the ladder, jump to 1. Fewer samples
      // → no evidence, no action.
      if (!fpsDecided) {
        if (elapsed <= SKIP_SAMPLE_WINDOW_MS) samples.push(now - lastFrame);
        else {
          fpsDecided = true;
          if (shouldSkipMaterialize(false, samples)) {
            finish(true);
            return;
          }
        }
      }
      lastFrame = now;
      if (elapsed >= budget) {
        finish(false);
        return;
      }
      setMaterializeScale(resolutionLadder(elapsed, budget, materialize.variant));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('click', onSkipClick, true);
      cancelAnimationFrame(raf);
    };
  }, [materialize, dispatchCeremony]);

  /** File import and save-current share one reveal — a new skin is born. */
  const startImportMaterialize = (list: SkinEntry[], skinId: string, beforeCount: number): boolean => {
    const entry = list.find((s) => s.id === skinId);
    if (!entry || !entry.dataUrl) return false; // no texture → caller previews instantly
    finalizeActiveMaterialize(); // settle any in-flight materialization — never two at once
    const announceFirst = isFirstSkin(beforeCount, beforeCount + 1);
    setPreviewId(skinId);         // the newborn IS the hero, from its first visible frame
    setMirrorEpoch((e) => e + 1); // remount → the GREETING wave plays during the climb
    setMaterialize({ variant: 'import', skinId, announceFirst });
    setMaterializeScale(IMPORT_LADDER[0]);
    return true;
  };

  const handleEquip = async (skin: SkinEntry) => {
    if (!canWearCustom) return;
    finalizeActiveMaterialize(); // settle any in-flight materialization — never two at once
    setEquip({ id: skin.id, phase: equipCeremonyNext('idle', { type: 'EQUIP_START' }), msg: 'wearing it now.' });
    try {
      const result = await window.electronAPI.skinsEquip(skin.id);
      if (!result.success) {
        setEquip({ id: skin.id, phase: 'fail', msg: result.error || 'couldn’t reach mojang. nothing changed.' });
        setFailFlash(true);
        setTimeout(() => setFailFlash(false), 200); // amber flashes red once, then returns
        return; // zero state changes on failure
      }
      playEquipSwell();
      recordAction('equip');
      await refreshWardrobe();
      if (!skin.dataUrl) {
        // No texture to materialize with (unreachable via the UI: missing-file
        // cards render no equip button) → the honest instant swap.
        setPreviewId(null);
        setMirrorEpoch((e) => e + 1);
        setEquip(null);
        return;
      }
      dispatchCeremony({ type: 'EQUIP_SUCCESS' }); // busy → materializing
      // v2: the hero itself materializes. Everything lands in one batch so
      // the remounted SkinViewerCanvas (new key) renders its first visible
      // frame of the equipped skin at the first rung — the GREETING wave
      // plays while the climb runs ("waves while it forms"). previewId
      // points at the equipped entry: the REAL worn bytes (v1's
      // previewId→null rendered the bundled Steve, not the worn skin).
      setPreviewId(skin.id);
      setMirrorEpoch((e) => e + 1);
      setMaterialize({ variant: 'equip', skinId: skin.id, announceFirst: false });
      setMaterializeScale(EQUIP_LADDER[0]);
      // The ladder owns the rest: rungs climb to 1 over 520ms (the button
      // dissolves in parallel via materializing → 'dissolving' kind), the
      // shelf amber underline lands as wearingHash flips mid-climb, and the
      // loop's finish clears the ceremony exactly at scale 1.
    } catch {
      setEquip({ id: skin.id, phase: 'fail', msg: 'couldn’t reach mojang. nothing changed.' });
      setFailFlash(true);
      setTimeout(() => setFailFlash(false), 200);
    }
  };

  const handleRename = async (skin: SkinEntry) => {
    const cleaned = renameValue.trim();
    setRenamingId(null);
    if (cleaned === skin.name || !cleaned) return;
    await window.electronAPI.skinsRename(skin.id, cleaned);
    recordAction('rename');
    await loadSkins();
  };

  const handleDelete = async (skin: SkinEntry) => {
    setConfirmDeleteId(null);
    await window.electronAPI.skinsDelete(skin.id);
    recordAction('delete');
    if (previewId === skin.id) setPreviewId(null); // hero falls back to the account skin
    await loadSkins();
  };

  const handleSetModel = async (skin: SkinEntry, model: 'classic' | 'slim') => {
    await window.electronAPI.skinsSetModel(skin.id, model);
    recordAction('set-model');
    await loadSkins();
  };

  // ── hero state derivation ─────────────────────────────────────────────
  // Tri-state per the handbook: undefined = resolving (render nothing),
  // null = confirmed no custom skin (bundled Steve), string = the skin.
  // Non-preview: the hero shows the skin the account is ACTUALLY wearing —
  // the §5.2 mirror fix (it used to fall to bundled Steve while the chip
  // claimed "worn skin"). Preview keeps its byte-exact card behavior.
  const heroResolving =
    skinsLoading || loading || (isMsActive && !isSignedOut && (wearingHash === null || !wornSkinReady));
  const worn = resolveWornSkin({
    resolving: heroResolving,
    wearingHash,
    wornDataUrl: wornSkin?.dataUrl ?? null,
    wornModel: wornSkin?.model ?? null,
    skins,
  });
  const heroUrl: string | null | undefined = previewed
    ? previewed.dataUrl // null (missing file) is a confirmed state the card explains
    : worn.url;
  const heroModel: 'slim' | 'default' = toViewerModel(
    previewed ? previewed.model : worn.model ?? 'classic',
  );
  const heroName = previewed ? previewed.name : activeAccount?.username ?? '—';
  // "worn skin" only when the hero really shows the worn texture (§5.2
  // honesty): confirmed-no-skin says 'default', the resolve window keeps the
  // pre-existing 'worn skin'.
  const heroChip = previewed
    ? previewed.model
    : isOfflineActive || worn.url === null
      ? 'default'
      : 'worn skin';
  const heroActive = previewed ? previewed.hash === wearingHash : true;
  const heroMissing = !!previewed && previewed.dataUrl === null;
  /** The library entry whose bytes the account is actually wearing. */
  const wornEntry = wearingHash ? skins.find((s) => s.hash === wearingHash) ?? null : null;

  const libraryEmpty = !skinsLoading && skins.length === 0;

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="dot-breathe h-[6px] w-[6px] rounded-full bg-ember" />
        <p className="microlabel">Loading accounts</p>
      </div>
    );
  }

  return (
    // py-6: the dock now lives in Layout's in-flow slot, so the old
    // pt-16/pb-24 floating-dock clearance is dead weight — at 900x600 it
    // alone pushed the hero 102px below the fold (measured: root sh 823).
    <div className="relative z-[1] flex h-full flex-col items-center overflow-y-auto px-10 py-6">
      {/* ── Account strip — one quiet row, never a bordered block ────────── */}
      <div className="rise d1 flex w-full max-w-[640px] items-center gap-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line">
          <span className="text-[11px] font-semibold text-dim">
            {(activeAccount?.username ?? '·').charAt(0).toUpperCase()}
          </span>
        </div>
        <span className="text-[13px] font-medium text-ink">{activeAccount?.username ?? 'no account'}</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
          {isOfflineActive
            ? 'offline'
            : isSignedOut
              ? 'signed out'
              : isMsActive
                ? 'connected'
                : '—'}
        </span>

        <div className="ml-auto flex items-center gap-2.5">
          {accounts.length > 1 && (
            <span className="flex items-center gap-1.5 text-[11px] text-faint">
              <button
                onClick={() => {
                  const idx = accounts.findIndex((a) => a.id === activeAccountId);
                  const prev = accounts[(idx - 1 + accounts.length) % accounts.length];
                  if (prev) window.electronAPI.setActiveAccount(prev.id).then(loadAccounts);
                }}
                className="px-1 transition-colors duration-micro hover:text-dim"
                aria-label="Previous account"
              >‹</button>
              {accounts.findIndex((a) => a.id === activeAccountId) + 1}/{accounts.length}
              <button
                onClick={() => {
                  const idx = accounts.findIndex((a) => a.id === activeAccountId);
                  const next = accounts[(idx + 1) % accounts.length];
                  if (next) window.electronAPI.setActiveAccount(next.id).then(loadAccounts);
                }}
                className="px-1 transition-colors duration-micro hover:text-dim"
                aria-label="Next account"
              >›</button>
            </span>
          )}
          {!activeAccount && (
            <button onClick={handleAddMicrosoft} disabled={msLoading} className="pill-ember !px-3.5 !py-1.5 !text-[11px]">
              {msLoading ? 'Opening Microsoft…' : 'Sign in with Microsoft'}
            </button>
          )}
          {activeAccount && isMsActive && !isSignedOut && (
            <button
              onClick={() => handleSignOut(activeAccount.id)}
              disabled={actionLoading === activeAccount.id}
              className="text-[11px] text-faint transition-colors duration-micro hover:text-dim disabled:opacity-40"
            >
              Sign out
            </button>
          )}
          {activeAccountId && confirmRemoveId === activeAccountId ? (
            <>
              <span className="text-[11px] text-faint">remove?</span>
              <button
                onClick={() => handleRemoveAccount(activeAccountId)}
                className="text-[11px] text-danger transition-colors duration-micro hover:text-danger/80"
              >
                yes
              </button>
              <button
                onClick={() => setConfirmRemoveId(null)}
                className="text-[11px] text-faint transition-colors duration-micro hover:text-dim"
              >
                no
              </button>
            </>
          ) : (
            activeAccount && (
              <button
                onClick={() => setConfirmRemoveId(activeAccountId)}
                className="text-[11px] text-faint transition-colors duration-micro hover:text-dim"
                title="Remove account"
              >
                remove
              </button>
            )
          )}
          {activeAccount && isSignedOut && (
            <button onClick={handleAddMicrosoft} disabled={msLoading} className="text-[11px] text-faint transition-colors duration-micro hover:text-dim">
              {msLoading ? 'Opening Microsoft…' : 'Sign in'}
            </button>
          )}
          <button
            onClick={() => setShowOfflineDialog(true)}
            className="text-[11px] text-faint transition-colors duration-micro hover:text-dim"
          >
            Add offline
          </button>
        </div>
      </div>
      <div className="hairline-t h-px w-full max-w-[640px]" />

      {/* ── The hero — same game. different you. ──────────────────────────── */}
      {/* min-height stays auto (NOT min-h-0): flex shrinks the elastic hero
          down to the column's content minimum and then stops — below that
          the root scroller takes over. With min-h-0 the column shrinks past
          its content and the equip row spills out, covered by the shelf
          (measured at 900x600 preview: equip hit by the shelf div). */}
      <div className="rise d2 flex w-full max-w-[640px] flex-col items-center pt-4">
        <p className="microlabel mb-2">Identity Studio</p>
        <p className="text-[13px] text-dim">same game. different you.</p>

        {/* Hero slot stays a definite 300px: the window floor is 600 tall
            (main/index.ts minHeight), so vh-style elasticity can never
            engage, and min-height tricks on a definite height don't change
            the parent's content minimum. Short-window overflow is handled
            by the root scroller (audit-verified: everything reachable,
            nothing covered). */}
        <div className="relative mt-2 h-[300px] w-[200px]">
          <SkinViewerCanvas
            key={mirrorEpoch}
            skinUrl={heroUrl}
            model={heroModel}
            interactive
            onOrbitStart={handleOrbitStart}
            materializeScale={materialize ? materializeScale : 1}
          />
          {showDragHint && heroUrl !== undefined && (
            <p className="pointer-events-none absolute -bottom-1 left-1/2 -translate-x-1/2 text-[11px] text-faint transition-opacity duration-300">
              drag to rotate
            </p>
          )}
        </div>

        {mirrorLine && (
          <p className="rise mt-3 text-[14px] font-medium text-ink">{mirrorLine}</p>
        )}
        {firstSkinMsg && (
          <p className="rise mt-3 text-[13px] text-ember">{firstSkinMsg}</p>
        )}

        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{heroName}</span>
          <span className="font-mono text-[10px] tabular-nums text-faint">{heroChip}</span>
          {!previewed && heroActive && <span className="text-[10px] font-semibold lowercase text-ok/80">active</span>}
        </div>

        {/* Task 1 — the wearing timeline (only when it's true) */}
        {!previewed && wornEntry?.lastEquippedAt && (
          <p className="mt-0.5 font-mono text-[10px] tabular-nums lowercase text-faint">
            {formatWearingSince(Date.parse(wornEntry.lastEquippedAt))}
          </p>
        )}

        {/* §5.2 mirror — the worn texture came from outside the library.
            Save-current (the existing path) is the only entry; no new logic. */}
        {!previewed && worn.fromOutsideEmber && canWearCustom && (
          <>
            <p className="mt-3 text-[12px] text-dim">wearing a skin from outside ember</p>
            <button onClick={handleSaveCurrent} className="pill-ember mt-3 !px-5 !py-2.5 !text-[12px]">
              save it to your library
            </button>
          </>
        )}

        {/* equip — the ceremony. The one amber BLOCK on this screen; the
            gaze layer needs no code: it already tracks the cursor, so
            hovering the button IS the gaze shift, and leaving returns it. */}
        {previewed && (
          <div className="mt-3 flex flex-col items-center gap-2">
            {(() => {
              const kind = equipButtonKind({
                previewed: true,
                heroMissing,
                isActiveSkin: heroActive,
                canWearCustom,
                phase: equipButtonPhase(equip && equip.id === previewed.id ? equip.phase : null),
              });
              if (kind.kind === 'wearing') {
                return <span className="text-[11px] lowercase text-ok/80">wearing it</span>;
              }
              if (kind.kind === 'missing') {
                return <p className="text-[11px] text-faint">this skin’s file is missing — delete it and re-add.</p>;
              }
              if (kind.kind === 'disabled-offline') {
                return (
                  <>
                    <button
                      disabled
                      className="cursor-default rounded-full bg-white/[0.05] px-[28px] py-[10px] text-[15px] font-semibold lowercase text-faint"
                    >
                      equip
                    </button>
                    <p className="text-[11px] text-faint">requires microsoft</p>
                  </>
                );
              }
              const isBusy = kind.kind === 'busy';
              const isDissolving = kind.kind === 'dissolving';
              return (
                <>
                  <style>{`@keyframes equip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.95; } }`}</style>
                  <button
                    onClick={() => handleEquip(previewed)}
                    disabled={isBusy || isDissolving}
                    style={isBusy ? { animation: 'equip-pulse 800ms ease-in-out infinite' } : undefined}
                    className={`rounded-full bg-ember px-[28px] py-[10px] text-[15px] font-semibold lowercase text-[var(--ground)] transition-all duration-micro ease-exit hover:-translate-y-0.5 hover:brightness-105 active:scale-[0.97] active:brightness-90 disabled:cursor-default ${
                      failFlash
                        ? 'border border-danger bg-danger/20 text-danger'
                        : isDissolving
                          ? 'opacity-0'
                          : 'border border-ember'
                    }`}
                  >
                    {isBusy ? 'wearing it now.' : 'equip'}
                  </button>
                  {equip?.id === previewed.id && equip.phase === 'fail' && (
                    <p className="text-[11px] text-danger/80">{equip.msg}</p>
                  )}
                </>
              );
            })()}
            {!heroActive && previewed.model !== heroChip && previewed.model && !heroMissing && canWearCustom && equip?.id !== previewed.id && (
              <div className="flex items-center gap-2 text-[10px] text-faint">
                <span>wrong arms?</span>
                <button
                  onClick={() => handleSetModel(previewed, previewed.model === 'slim' ? 'classic' : 'slim')}
                  className="underline transition-colors duration-micro hover:text-dim"
                >
                  switch to {previewed.model === 'slim' ? 'classic' : 'slim'}
                </button>
              </div>
            )}
          </div>
        )}

        {!previewed && libraryEmpty && canWearCustom && !worn.fromOutsideEmber && ( // outside-ember shows its own save pill above
          <button onClick={handleSaveCurrent} className="pill-ember mt-3 !px-5 !py-2.5 !text-[12px]">
            save this skin to your library
          </button>
        )}
        {!previewed && isOfflineActive && (
          <p className="mt-3 max-w-[46ch] text-center text-[12px] leading-relaxed text-faint">
            offline accounts wear the default look. skins live on microsoft accounts —
            switch to one to build a wardrobe.
          </p>
        )}
        {!previewed && isSignedOut && (
          <p className="mt-3 max-w-[46ch] text-center text-[12px] leading-relaxed text-faint">
            sign in with microsoft to wear a skin of your own.
          </p>
        )}
        {duplicateMsg && (
          <p className="mt-2 text-[11px] text-dim">{duplicateMsg}</p>
        )}
      </div>

      {/* ── The shelf — horizontal wardrobe rail ─────────────────────────── */}
      <div className="rise d3 mt-6 w-full max-w-[640px]">
        <div className="hairline-t mb-3 h-px" />
        <p className="microlabel mb-3">your library</p>

        {skinsLoading ? (
          <div className="flex items-center justify-center gap-2.5 py-8">
            <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
            <p className="microlabel">Loading skins</p>
          </div>
        ) : (
          <div className="flex items-start gap-3 overflow-x-auto pb-2">
            {skins.map((skin) => {
              const isActive = skin.hash === wearingHash && !!wearingHash;
              const isPreviewed = previewId === skin.id;
              const isEquipping = equip?.id === skin.id && (equip.phase === 'busy' || equip.phase === 'materializing');
              const confirming = confirmDeleteId === skin.id;
              return (
                <div
                  key={skin.id}
                  onClick={() => {
                    if (previewId !== skin.id) playSelectTick(); // shelf select → light tick
                    setPreviewId(skin.id);
                    setEquip(null);
                  }}
                  className={`group relative flex w-[104px] shrink-0 cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border px-3 py-3 transition-all duration-micro ease-exit hover:-translate-y-1 hover:rotate-[1.2deg] hover:border-line-strong ${
                    isPreviewed
                      ? 'border-ember/60 bg-white/[0.02]'
                      : 'border-line bg-transparent'
                  } ${firstInId === skin.id ? 'scale-95 opacity-0' : 'scale-100 opacity-100'}`}
                >
                  <SkinHead dataUrl={skin.dataUrl} />
                  {renamingId === skin.id ? (
                    <input
                      value={renameValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(skin);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => handleRename(skin)}
                      maxLength={40}
                      className="w-full rounded-[4px] border border-line-strong bg-white/[0.03] px-1 py-0.5 text-center text-[11px] text-ink outline-none"
                    />
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingId(skin.id);
                        setRenameValue(skin.name);
                      }}
                      className="max-w-full truncate text-[11px] lowercase text-dim transition-colors duration-micro hover:text-ink"
                      title="Rename"
                    >
                      {skin.name}
                    </button>
                  )}

                  {isActive ? (
                    <>
                      {/* 落位动画: scaleX from origin-left — the soft landing of
                          the existing ease-exit curve reads as the settle. */}
                      <span
                        className={`h-[2px] w-8 origin-left rounded-full bg-ember transition-transform duration-300 ease-exit ${
                          isActive ? 'scale-x-100' : 'scale-x-0'
                        }`}
                        aria-hidden
                      />
                      <span className="text-[10px] lowercase text-ok/80">active</span>
                    </>
                  ) : confirming ? (
                    <div className="flex items-center gap-1 text-[10px]">
                      <span className="text-faint">delete?</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(skin); }}
                        className="text-danger transition-colors duration-micro hover:text-danger/80"
                      >
                        yes
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                        className="text-faint transition-colors duration-micro hover:text-dim"
                      >
                        no
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-micro group-hover:opacity-100">
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(skin.id); }}
                        className="text-[10px] text-faint transition-colors duration-micro hover:text-danger"
                        title="Delete skin"
                      >
                        delete
                      </button>
                      <span className="text-faint">·</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); window.electronAPI.skinsReveal(skin.id); }}
                        className="text-[10px] text-faint transition-colors duration-micro hover:text-dim"
                        title="Show in folder"
                      >
                        reveal
                      </button>
                    </div>
                  )}
                  {isEquipping && <div className="dot-breathe absolute right-2 top-2 h-[4px] w-[4px] rounded-full bg-ember" />}
                </div>
              );
            })}

            {/* [+ add] — the dashed invitation */}
            <button
              onClick={handleAddSkin}
              className="group flex w-[104px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line-strong px-3 py-3 transition-colors duration-micro hover:border-dim"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeLinecap="round" className="transition-colors duration-micro group-hover:stroke-[var(--dim)]">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="text-[11px] lowercase text-faint transition-colors duration-micro group-hover:text-dim">
                add a skin
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Error line — words, not boxes */}
      {error && (
        <div className="rise mt-4 w-full max-w-[640px]">
          <p className="text-[12px] text-danger/80">{error}</p>
        </div>
      )}

      {/* ── Offline account dialog (preserved as-is) ─────────────────────── */}
      {showOfflineDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowOfflineDialog(false)} />
          <div className="surface panel-in relative m-4 w-full max-w-[380px] rounded-[18px] p-8">
            <button
              onClick={() => setShowOfflineDialog(false)}
              className="absolute right-5 top-4 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
              aria-label="Close"
            >
              &times;
            </button>
            <p className="microlabel mb-3">Offline Account</p>
            <h2 className="font-display text-[24px] font-bold tracking-[-0.03em] text-ink">
              Play without signing in.
            </h2>
            <p className="mt-3 text-[13px] leading-relaxed text-dim">
              Offline accounts work without internet. You can&rsquo;t join multiplayer servers.
            </p>
            <div className="mt-6">
              <input
                type="text"
                value={offlineName}
                onChange={(e) => { setOfflineName(e.target.value); setOfflineError(null); }}
                onKeyDown={(e) => e.key === 'Enter' && handleAddOffline()}
                placeholder="Username"
                maxLength={16}
                className="w-full rounded-[10px] border border-line bg-white/[0.03] px-4 py-3 text-[14px] text-ink placeholder:text-faint transition-colors duration-micro focus:border-ember/30 focus:outline-none"
                autoFocus
              />
              {offlineError && <p className="mt-2 text-[12px] text-danger/80">{offlineError}</p>}
            </div>
            <div className="mt-6 flex items-center gap-3">
              <button className="pill-ghost" onClick={() => setShowOfflineDialog(false)}>Cancel</button>
              <button
                className="pill-ember"
                onClick={handleAddOffline}
                disabled={!offlineName.trim() || actionLoading === 'offline'}
              >
                {actionLoading === 'offline' ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default IdentityView;
