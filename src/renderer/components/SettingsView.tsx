import React from 'react';

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
}

/**
 * Setup view — honest by design (DESIGN.md Law 6, PROD-003 kill list):
 * a manifest of what the launcher handles, for the world that will actually
 * launch. Hairline rows, mono values, no fake controls. Values follow the
 * active world — a hardcoded manifest becomes a lie the moment a personal
 * world is active.
 */
const SettingsView: React.FC<SettingsViewProps> = ({ activeWorld }) => {
  const loader = !activeWorld
    ? '—'
    : activeWorld.loader === 'vanilla'
      ? 'Vanilla'
      : `${activeWorld.loader.charAt(0).toUpperCase() + activeWorld.loader.slice(1)} ${activeWorld.loaderVersion}`;

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'World', value: activeWorld?.name ?? '—' },
    { label: 'Minecraft', value: activeWorld?.version ?? '—', mono: true },
    { label: 'Mod loader', value: loader, mono: true },
    { label: 'Memory', value: activeWorld ? `${activeWorld.ramAllocation / 1024} GB` : '—', mono: true },
    { label: 'Java runtime', value: 'Provisioned automatically' },
    {
      label: 'Mods & packs',
      value: activeWorld?.type === 'personal' ? 'Yours to manage' : 'Synced on every launch',
    },
    { label: 'Server', value: activeWorld?.assignedServer?.ip ?? '—', mono: true },
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
      </div>
    </div>
  );
};

export default SettingsView;
