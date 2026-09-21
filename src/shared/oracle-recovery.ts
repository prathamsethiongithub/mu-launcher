/**
 * Oracle Recovery — the pure mapping layer between a crash attribution and
 * the launcher's existing repair pipelines.
 *
 * The Oracle (crash-diagnostic.ts) answers "what crashed and why". This
 * module answers "what can the user do about it" — as a LIST of actions
 * over pipelines that already exist:
 *
 *   'update-mod'     → 'perform-mod-update'  (update-checker.performUpdate)
 *   'remove-mod'     → 'mod-delete'          (mod-manager)
 *   'adjust-memory'  → 'update-world-settings' (RAM bounds 1024–16384)
 *   'open-console'   → the existing console (Ctrl+L / onOpenConsole)
 *
 * This layer performs MAPPING ONLY. It never touches the filesystem, the
 * registry, or any IPC channel: the renderer executes each action through
 * the handler listed above. Two red lines are enforced here and re-enforced
 * in the UI:
 *
 *   1. An undefined (unattributed) diagnosis NEVER yields a repair action —
 *      only 'open-console'. False hope is not honest.
 *   2. A mod action is only ever offered when the diagnosis's mod name can
 *      actually be matched to an installed mod file. A mod we cannot see
 *      in mods/ cannot be repaired from here.
 *
 * Pure: no Electron, no fs, no side effects — fully vitest-able.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** The renderer-facing subset of a diagnose-world result this layer consumes. */
export interface DiagnosisInput {
  reason?: string;
  modName?: string;
}

/**
 * One installed mod file as the renderer sees it (window.electronAPI.listMods
 * shape — displayName included, since Oracle's prettified mod name matches
 * display names far better than raw jar filenames).
 */
export interface InstalledMod {
  filename: string;
  displayName: string;
  enabled?: boolean;
}

/**
 * The subset of the update-checker's ModUpdateInfo the mapping needs. The
 * "has an update?" branch of the decision table is driven by this list, and
 * its `filename`/`downloadUrl`/`newFilename` are the execution handles
 * performModUpdate needs.
 */
export interface ModUpdateInfoLike {
  filename: string;
  modId: string;
  downloadUrl: string;
  newFilename: string;
}

/** What the renderer already knows, assembled from existing state. */
export interface RecoveryContext {
  mods?: InstalledMod[];
  updates?: ModUpdateInfoLike[];
  /** Current RAM allocation in MB. Handler bounds: 1024–16384. */
  ramAllocation?: number;
}

export type RecoveryActionId =
  | 'update-mod'
  | 'remove-mod'
  | 'adjust-memory'
  | 'open-console';

export type Confidence = 'high' | 'low';

export interface RecoveryAction {
  id: RecoveryActionId;
  /** Lowercase human words — same voice as "couldn't reach mojang". */
  label: string;
  /**
   * 'high' = specific mod name, matched to an installed file.
   * 'low'  = OOM attribution (reason-shaped, not mod-named).
   * The console fallback is always 'high': it is unconditionally available.
   */
  confidence: Confidence;
  /** The diagnosis the action was computed from (carried for the executor). */
  diagnosis: DiagnosisInput;
  /** The installed file to act on — filename for update/remove only. */
  filename?: string;
}

// ── Matching primitives ──────────────────────────────────────────────────────

/**
 * Canonicalize a mod identity for matching: lowercase, strip everything
 * except [a-z0-9] — so "Sodium", "sodium-extra", "sodium extra 0.5.3" and
 * "sodium-0.5.3.jar" all collapse to comparable keys.
 */
export function canonicalModKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is the diagnosis's mod name (e.g. "Corrupted Mod", "Sodium") referring to
 * this installed file? Three-way match, first hit wins:
 *
 *   1. canonical equality   — "Sodium" vs "Sodium.jar" → "sodium" both sides.
 *   2. prefix containment   — the SHORTER canonical key is a prefix of the
 *                             longer one ("sodium" ⊂ "sodium053jar"): a
 *                             diagnosis names the MOD, the file may carry a
 *                             versioned tail, and vice versa for reports
 *                             that name the file.
 *   3. substring containment — "corrupted mod" ⊂ "corruptedmod10jar": the
 *                             report's phrasing is a fragment of the actual
 *                             filename. This is what makes the corrupt-jar
 *                             corpus record actionable — canonical equality
 *                             fails both directions there ("corruptedmod" vs
 *                             "corruptedmod10"), but containment holds.
 */
export function modNameMatchesFile(modName: string, file: InstalledMod): boolean {
  const diagKey = canonicalModKey(modName);
  if (diagKey.length < 3) return false; // too vague to act on honestly
  const candidates = [file.displayName, file.filename];
  for (const candidate of candidates) {
    const fileKey = canonicalModKey(candidate);
    if (fileKey.length === 0) continue;
    if (diagKey === fileKey) return true;
    if (diagKey.length <= fileKey.length && fileKey.startsWith(diagKey)) return true;
    if (fileKey.length <= diagKey.length && diagKey.startsWith(fileKey)) return true;
    if (diagKey.includes(fileKey) || fileKey.includes(diagKey)) return true;
  }
  return false;
}

/**
 * Find the installed file (if any) the diagnosis's mod name refers to.
 * Direct-update hits win first: the update list already resolved the real
 * project identity (modId from fabric.mod.json), so it is the strongest
 * evidence. Then installed files, preferring enabled ones.
 */
export function findMatchedMod(
  modName: string,
  context: RecoveryContext,
): { file: InstalledMod; update?: ModUpdateInfoLike } | null {
  // 1. The update checker's own identity resolution.
  const update = context.updates?.find(
    (u) => modNameMatchesFile(modName, { filename: u.filename, displayName: u.modId }),
  );
  const byUpdate = update
    ? context.mods?.find((m) => m.filename === update.filename)
    : undefined;
  if (update && byUpdate) return { file: byUpdate, update };

  // 2. Direct scan of the installed files. Enabled mods outrank disabled
  //    ones (a disabled mod cannot crash a launch that didn't load it).
  const enabled = context.mods?.filter((m) => m.enabled !== false) ?? [];
  const disabled = context.mods?.filter((m) => m.enabled === false) ?? [];
  for (const pool of [enabled, disabled]) {
    const hit = pool.find((m) => modNameMatchesFile(modName, m));
    if (hit) return { file: hit };
  }
  return null;
}

// ── OOM detection ────────────────────────────────────────────────────────────

/**
 * Is this reason an out-of-memory attribution? Same fact source as
 * crash-diagnostic.detectReason — it produces exactly one OOM reason
 * string ("Out of memory (java.lang.OutOfMemoryError)"), so matching the
 * exception name keeps both sides honest without coupling to its exact text.
 */
export function isOomReason(reason?: string): boolean {
  if (!reason) return false;
  return /OutOfMemoryError/i.test(reason);
}

// ── Confidence ───────────────────────────────────────────────────────────────

/**
 * Attribution confidence cascade: specific mod name > OOM > unknown.
 * An unknown/undefined attribution is ALWAYS low here — the UI turns low
 * attribution into console-only honesty, never repair buttons.
 */
export function attributionConfidence(diagnosis: DiagnosisInput): Confidence | 'unknown' {
  if (diagnosis.modName) return 'high';
  if (isOomReason(diagnosis.reason)) return 'low';
  return 'unknown';
}

// ── The decision table ───────────────────────────────────────────────────────

/**
 * mapDiagnosisToActions — the decision table, as code.
 *
 * | attribution            | installed match? | update? | actions                      |
 * |------------------------|------------------|---------|------------------------------|
 * | modName=X (mix/parse)  | yes              | yes     | update + remove + console    |
 * | modName=X              | yes              | no      | remove + console             |
 * | modName=X              | no               | —       | console only + honest note   |
 * | OOM reason             | —                | —       | adjust-memory + console      |
 * | undefined              | —                | —       | console only                 |
 */
export function mapDiagnosisToActions(
  diagnosis: DiagnosisInput,
  context: RecoveryContext = {},
): RecoveryAction[] {
  const actions: RecoveryAction[] = [];
  const modName = diagnosis.modName?.trim();

  // Branch 1–3: a named mod drives the mod actions.
  if (modName) {
    const matched = findMatchedMod(modName, context);
    if (matched) {
      if (matched.update) {
        actions.push({
          id: 'update-mod',
          label: `update ${modName.toLowerCase()}`,
          confidence: 'high',
          diagnosis,
          filename: matched.file.filename,
        });
      }
      actions.push({
        id: 'remove-mod',
        label: matched.update ? 'remove it instead' : 'remove it',
        confidence: 'high',
        diagnosis,
        filename: matched.file.filename,
      });
    }
    // No match → no mod action at all. The UI adds the honest note.
  }

  // Branch 4: OOM — reason-shaped attribution, no mod to name.
  if (!modName && isOomReason(diagnosis.reason)) {
    actions.push({
      id: 'adjust-memory',
      label: 'give it more memory',
      confidence: 'low',
      diagnosis,
    });
  }

  // The console fallback: unconditional, every branch. Even an undefined
  // attribution keeps this one — "details in the console" is the honest
  // answer, and the console is how the user gets them.
  actions.push({ id: 'open-console', label: 'show evidence', confidence: 'high', diagnosis });

  return actions;
}

/**
 * The honest line the UI shows when the diagnosis names a mod that is NOT
 * installed (external origin — skins folder, another launcher, already
 * removed). Undefined when the diagnosis didn't name a mod at all.
 */
export function unmatchedModNote(diagnosis: DiagnosisInput, context: RecoveryContext): string | null {
  const modName = diagnosis.modName?.trim();
  if (!modName) return null;
  if (findMatchedMod(modName, context)) return null;
  return `${modName.toLowerCase()} isn't installed here — this launcher can't fix it. details in the console.`;
}
