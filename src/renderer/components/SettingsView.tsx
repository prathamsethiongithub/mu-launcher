import React, { useState, useEffect } from 'react';

interface WorldData {
  id: string;
  name: string;
  type: 'managed' | 'personal';
  version: string;
  loader: string;
  loaderVersion: string;
  ramAllocation: number;
  assignedServer: { ip: string; port: number; label?: string } | null;
}

interface SettingsViewProps {
  activeWorld: WorldData | null;
  onWorldsChanged: () => void;
}

const RAM_MIN = 1024;
const RAM_MAX = 16384;
const RAM_STEP = 512;

/**
 * Setup view — honest by design (DESIGN.md Law 6, PROD-003 kill list):
 * a manifest of what the launcher handles, for the world that will actually
 * launch. Hairline rows, mono values, no fake controls. Values follow the
 * active world — a hardcoded manifest becomes a lie the moment a personal
 * world is active.
 *
 * Memory is the one real control: it is machine tuning (not world identity),
 * editable here and passed to the JVM at launch. The row keeps the hairline
 * grammar — mono tabular value, inline edit, quiet save/cancel (the same
 * pattern as the world rename in WorldsView).
 */
const SettingsView: React.FC<SettingsViewProps> = ({ activeWorld, onWorldsChanged }) => {
  const [editingRam, setEditingRam] = useState(false);
  const [ramDraft, setRamDraft] = useState(activeWorld?.ramAllocation ?? 4096);
  const [ramError, setRamError] = useState<string | null>(null);
  const [ramSaving, setRamSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Re-seed the draft when the active world changes (world switch / save).
  useEffect(() => {
    setRamDraft(activeWorld?.ramAllocation ?? 4096);
    setRamError(null);
  }, [activeWorld?.id, activeWorld?.ramAllocation]);

  if (!activeWorld) {
    return (
      <div className="relative z-[1] flex h-full flex-col items-center justify-center px-10">
        <p className="rise microlabel mb-6 !text-faint">Setup</p>
        <p className="rise d1 text-[14px] text-dim">No active world.</p>
      </div>
    );
  }

  const loader = activeWorld.loader === 'vanilla'
    ? 'Vanilla'
    : `${activeWorld.loader.charAt(0).toUpperCase() + activeWorld.loader.slice(1)} ${activeWorld.loaderVersion}`;

  const startEdit = () => {
    setRamDraft(activeWorld.ramAllocation);
    setRamError(null);
    setEditingRam(true);
  };

  const saveRam = async () => {
    const ram = Math.round(ramDraft);
    if (!Number.isFinite(ram) || ram < RAM_MIN || ram > RAM_MAX) {
      setRamError(`Between ${RAM_MIN / 1024} and ${RAM_MAX / 1024} GB.`);
      return;
    }
    if (ram === activeWorld.ramAllocation) {
      setEditingRam(false);
      setRamError(null);
      return;
    }
    setRamSaving(true);
    setRamError(null);
    try {
      const result = await window.electronAPI.updateWorldSettings(activeWorld.id, {
        ramAllocation: ram,
      });
      if (!result.success) {
        setRamError(result.error || 'Could not save.');
        return;
      }
      setEditingRam(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
      onWorldsChanged();
    } catch {
      setRamError('Could not save.');
    } finally {
      setRamSaving(false);
    }
  };

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'World', value: activeWorld.name },
    { label: 'Minecraft', value: activeWorld.version, mono: true },
    { label: 'Mod loader', value: loader, mono: true },
    { label: 'Java runtime', value: 'Provisioned automatically' },
    {
      label: 'Mods & packs',
      value: activeWorld.type === 'personal' ? 'Yours to manage' : 'Synced on every launch',
    },
    { label: 'Server', value: activeWorld.assignedServer?.ip ?? '—', mono: true },
  ];

  return (
    <div className="relative z-[1] flex h-full flex-col items-center justify-center px-10">
      <p className="rise microlabel mb-6 !text-faint">Setup</p>

      <h1 className="rise d1 text-center font-display text-[56px] font-bold leading-[1.04] tracking-[-0.04em] text-ink">
        Handled.
      </h1>

      <p className="rise d2 mt-5 max-w-[48ch] text-center text-[14px] leading-relaxed text-dim">
        Everything below is tuned and kept in sync automatically —
        there&rsquo;s nothing you need to configure.
      </p>

      <div className="rise d3 mt-12 w-full max-w-[460px]">
        {rows.map(({ label, value, mono }) => (
          <div
            key={label}
            className="hairline-t flex h-12 items-center justify-between last:border-b last:border-b-[var(--line)]"
          >
            <span className="text-[13px] text-dim">{label}</span>
            <span className={`text-[12px] text-ink/85 ${mono ? 'font-mono tabular-nums' : ''}`}>
              {value}
            </span>
          </div>
        ))}

        {/* Memory — the one real control. Hairline grammar, inline edit. */}
        <div className="hairline-t flex min-h-12 flex-col justify-center border-b border-b-[var(--line)] py-2">
          {editingRam ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-dim">Memory</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setRamDraft((v) => Math.max(RAM_MIN, v - RAM_STEP))}
                    disabled={ramSaving}
                    aria-label="Decrease memory"
                    className="flex h-6 w-6 items-center justify-center rounded-full text-dim transition-colors duration-micro hover:bg-white/[0.05] hover:text-ink disabled:opacity-30"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M5 12h14" /></svg>
                  </button>
                  <span data-ram-draft className="w-[54px] text-center font-mono text-[12px] tabular-nums text-ink">
                    {(ramDraft / 1024).toFixed(1)}
                  </span>
                  <span className="text-[11px] text-faint">GB</span>
                  <button
                    onClick={() => setRamDraft((v) => Math.min(RAM_MAX, v + RAM_STEP))}
                    disabled={ramSaving}
                    aria-label="Increase memory"
                    className="flex h-6 w-6 items-center justify-center rounded-full text-dim transition-colors duration-micro hover:bg-white/[0.05] hover:text-ink disabled:opacity-30"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                {ramError && <p className="mr-auto text-[11px] text-danger/80">{ramError}</p>}
                <button
                  onClick={saveRam}
                  disabled={ramSaving}
                  className="pill-ghost !px-3 !py-1 !text-[11px]"
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditingRam(false); setRamError(null); }}
                  className="text-[12px] text-faint hover:text-dim"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-12 items-center justify-between">
              <span className="text-[13px] text-dim">Memory</span>
              <div className="flex items-center gap-2">
                {savedFlash && (
                  <span data-ram-saved className="rise text-[11px] text-ok/60">Saved</span>
                )}
                <span data-ram-value className="font-mono text-[12px] tabular-nums text-ink/85">
                  {activeWorld.ramAllocation / 1024} GB
                </span>
                <button
                  onClick={startEdit}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-faint transition-colors duration-micro hover:bg-white/[0.05] hover:text-dim"
                  aria-label="Edit memory"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M11 4H4v16h16v-7M18.5 2.5l3 3L11 16l-4 1 1-4 12.5-12.5z" /></svg>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsView;
