import React, { useState, useEffect, useCallback, useRef } from 'react';
import NewWorldDialog from './NewWorldDialog';
import ModManagerModal from './ModManagerModal';

interface WorldData {
  id: string;
  name: string;
  type: 'managed' | 'personal';
  version: string;
  loader: string;
  loaderVersion: string;
  ramAllocation: number;
  assignedServer: { ip: string; port: number; label?: string } | null;
  lastPlayedAt: number | null;
  broken: boolean;
  createdAt: number;
}

interface WorldsViewProps {
  worlds: WorldData[];
  activeWorldId: string | null;
  onSetActive: (id: string) => void;
  onWorldsChanged: () => void;
  /** Launch a world directly from the shelf. Omit to hide the Play buttons. */
  onPlayWorld?: (worldId: string) => void;
}

type HealthStatus = 'healthy' | 'warning' | 'corrupted';

interface WorldMetrics {
  worldSize: number;
  backupSize: number;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'Never played';
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days > 30) return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return 'Just now';
}

function humanSize(bytes: number): string {
  if (bytes === 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  const kb = bytes / 1024;
  return `${Math.round(kb)} KB`;
}

const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  corrupted: 'Corrupted',
};

// Type carries the state (Law 2); ember is never a caution color — it means
// "the primary action", nothing else. Warnings are words, in dim.
const HEALTH_COLOR: Record<HealthStatus, string> = {
  healthy: 'text-ok/60',
  warning: 'text-dim',
  corrupted: 'text-danger/60',
};

const WorldsView: React.FC<WorldsViewProps> = ({ worlds, activeWorldId, onSetActive, onWorldsChanged, onPlayWorld }) => {
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, WorldMetrics>>({});
  const [health, setHealth] = useState<Record<string, HealthStatus>>({});
  const [backupCounts, setBackupCounts] = useState<Record<string, number>>({});
  const [expandedBackupsId, setExpandedBackupsId] = useState<string | null>(null);
  const [backupsList, setBackupsList] = useState<{ name: string; date: number; size: number }[]>([]);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [pendingModpack, setPendingModpack] = useState<{ name: string; version: string; minecraft: string; loader: string; filePath: string } | null>(null);
  // Which world's Mod Manager modal is open (null = closed).
  const [modManagerWorld, setModManagerWorld] = useState<{ id: string; name: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Load metrics + health for each world
  const loadMetrics = useCallback(async () => {
    for (const world of worlds) {
      try {
        const m = await window.electronAPI.getWorldMetrics(world.id);
        setMetrics((prev) => ({ ...prev, [world.id]: m }));
      } catch { /* non-fatal */ }
      try {
        const h = await window.electronAPI.checkWorldHealth(world.id);
        setHealth((prev) => ({ ...prev, [world.id]: h }));
      } catch { /* non-fatal */ }
      try {
        const backups = await window.electronAPI.getBackups(world.id);
        setBackupCounts((prev) => ({ ...prev, [world.id]: backups.length }));
      } catch { /* non-fatal */ }
    }
  }, [worlds]);

  useEffect(() => { loadMetrics(); }, [worlds, loadMetrics]);

  const sorted = [...worlds].sort((a, b) => {
    if (a.type === 'managed' && b.type !== 'managed') return -1;
    if (a.type !== 'managed' && b.type === 'managed') return 1;
    const aTime = a.lastPlayedAt || 0;
    const bTime = b.lastPlayedAt || 0;
    return bTime - aTime;
  });

  const handleRename = async (worldId: string) => {
    if (!renameValue.trim()) { setRenameError('Name cannot be empty.'); return; }
    setActionLoading(worldId);
    setRenameError(null);
    try {
      const result = await window.electronAPI.renameWorld(worldId, renameValue);
      if (!result.success) { setRenameError(result.error || 'Failed to rename.'); return; }
      setRenamingId(null);
      setRenameValue('');
      onWorldsChanged();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (worldId: string) => {
    setActionLoading(worldId);
    try {
      await window.electronAPI.deleteWorld(worldId);
      setDeletingId(null);
      onWorldsChanged();
    } catch {
      setDeletingId(null);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDuplicate = async (worldId: string) => {
    setActionLoading(worldId);
    setMenuOpenId(null);
    try {
      await window.electronAPI.duplicateWorld(worldId);
      onWorldsChanged();
    } finally {
      setActionLoading(null);
    }
  };

  const handleBackup = async (worldId: string) => {
    setActionLoading(worldId);
    setMenuOpenId(null);
    setBackupMessage(null);
    try {
      const result = await window.electronAPI.backupWorld(worldId);
      if (!result.success) {
        setBackupMessage(result.error || 'Backup failed.');
        return;
      }
      // Verify the backup
      const backupName = result.backupPath?.split(/[\\/]/).pop() || '';
      if (backupName) {
        const verify = await window.electronAPI.verifyBackup(worldId, backupName);
        if (verify.verified) {
          setBackupMessage('Verified backup.');
        } else if (verify.success) {
          setBackupMessage('Backup created but not verified — ' + (verify.error || 'missing level.dat.'));
        } else {
          setBackupMessage('Backup created but verification failed.');
        }
      }
      loadMetrics();
    } finally {
      setActionLoading(null);
    }
  };

  const toggleBackups = async (worldId: string) => {
    if (expandedBackupsId === worldId) {
      setExpandedBackupsId(null);
      return;
    }
    setExpandedBackupsId(worldId);
    setMenuOpenId(null);
    setBackupMessage(null);
    try {
      const backups = await window.electronAPI.getBackups(worldId);
      setBackupsList(backups);
    } catch {
      setBackupsList([]);
    }
  };

  const handleRestore = async (worldId: string, backupName: string) => {
    setActionLoading(worldId);
    try {
      const result = await window.electronAPI.restoreWorld(worldId, backupName);
      if (result.success) {
        setRestoringBackup(null);
        setBackupMessage('Restored from backup.');
        loadMetrics();
      } else {
        setBackupMessage(result.error || 'Restore failed.');
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteBackup = async (worldId: string, backupName: string) => {
    setActionLoading(`${worldId}-${backupName}`);
    try {
      await window.electronAPI.deleteBackup(worldId, backupName);
      const backups = await window.electronAPI.getBackups(worldId);
      setBackupsList(backups);
      loadMetrics();
    } finally {
      setActionLoading(null);
      setDeletingBackup(null);
    }
  };

  return (
    <div
      className="relative z-[1] flex h-full flex-col items-center px-10 pt-20 pb-24"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        // Electron ≥32 removed File.path — resolve through the preload bridge.
        const filePath = window.electronAPI.getPathForFile(file);
        if (!filePath) return;
        // Only modpack archives are meaningful here — tell the user instead of
        // silently doing nothing with a stray .txt or .png.
        const lower = filePath.toLowerCase();
        if (!lower.endsWith('.mrpack') && !lower.endsWith('.zip')) {
          setError('Only .mrpack or .zip modpack files are supported.');
          setTimeout(() => setError(null), 3000);
          return;
        }
        const result = await window.electronAPI.parseModpack(filePath);
        if (result.success && result.modpack) {
          setPendingModpack({ ...result.modpack, filePath });
        } else {
          setError(result.error || 'Not a valid Modrinth modpack');
          setTimeout(() => setError(null), 3000);
        }
      }}
    >
      {/* Header */}
      <div className="rise d1 mb-12 w-full max-w-[520px]">
        <p className="microlabel mb-3">Worlds</p>
        <p className="text-[14px] text-dim">
          {worlds.length === 1
            ? 'One world ready. Make a space of your own below.'
            : `${worlds.length} worlds. The active one launches when you press Play.`}
        </p>
      </div>

      {/* Shelf */}
      <div className="rise d2 flex w-full max-w-[520px] flex-col">
        {sorted.map((world, idx) => {
          const isActive = world.id === activeWorldId;
          const isRenaming = renamingId === world.id;
          const isDeleting = deletingId === world.id;
          const isManaged = world.type === 'managed';
          const wHealth = health[world.id] || 'healthy';
          const wMetrics = metrics[world.id] || { worldSize: 0, backupSize: 0 };
          const backups = backupCounts[world.id] || 0;
          const isLoading = actionLoading === world.id;

          return (
            <React.Fragment key={world.id}>
              <div
                role="button"
                tabIndex={world.broken || isActive ? -1 : 0}
                onClick={() => !world.broken && !isActive && onSetActive(world.id)}
                className={`group relative mb-2 flex items-center gap-4 rounded-[12px] border border-white/[0.06] py-4 pl-5 pr-5 transition-all duration-micro ease-exit hover:border-white/[0.12] ${
                  isDeleting ? 'opacity-0' : ''
                } ${isActive ? 'border-ember/30' : ''} ${world.broken || isActive ? 'cursor-default' : 'cursor-pointer'}`}
              >
                {/* Active rail */}
                {isActive && (
                  <span className="absolute left-0 top-0 h-full w-[2px] rounded-l-[12px] bg-ember/50" />
                )}

                {/* Icon */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                  {isManaged ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isActive ? 'var(--dim)' : 'var(--faint)'} strokeWidth={1.5} strokeLinecap="round" className="transition-colors duration-micro">
                      <path d="M12 2L3 7v6c0 5 3.5 8.5 9 9 5.5-.5 9-4 9-9V7l-9-5z" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isActive ? 'var(--dim)' : 'var(--faint)'} strokeWidth={1.5} strokeLinecap="round" className="transition-colors duration-micro group-hover:stroke-dim">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <path d="M4 10h16" />
                    </svg>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-0.5">
                  {isRenaming ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(world.id);
                          if (e.key === 'Escape') { setRenamingId(null); setRenameError(null); }
                        }}
                        autoFocus
                        className="w-full rounded-[6px] border border-ember/30 bg-white/[0.03] px-2 py-1 text-[14px] text-ink focus:outline-none"
                        placeholder={world.name}
                      />
                      <button
                        onClick={() => handleRename(world.id)}
                        disabled={isLoading}
                        className="pill-ghost !px-3 !py-1 !text-[11px]"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setRenamingId(null); setRenameError(null); }}
                        className="text-[12px] text-faint hover:text-dim"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`text-[15px] font-semibold tracking-[-0.01em] transition-colors duration-micro ${
                          isActive ? 'text-ink' : 'text-dim group-hover:text-ink'
                        } ${world.broken ? 'opacity-40' : ''}`}
                      >
                        {world.name}
                      </span>
                      {isManaged && (
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dim/70">Managed</span>
                      )}
                      {world.broken && (
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-danger/60">Broken</span>
                      )}
                      {!world.broken && wHealth !== 'healthy' && (
                        <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${HEALTH_COLOR[wHealth]}`}>
                          {HEALTH_LABEL[wHealth]}
                        </span>
                      )}
                    </div>
                  )}
                  {renameError && renamingId === world.id && (
                    <p className="text-[11px] text-danger/80">{renameError}</p>
                  )}
                  {/* Instance facts — quiet sans, stacked. The server line only
                      appears when the world has an assigned one. */}
                  <div className="flex flex-col gap-1 text-[12px]">
                    <span className="text-dim">Minecraft {world.version} · {world.loader === 'vanilla' ? 'Vanilla' : `Fabric ${world.loaderVersion}`}</span>
                    <span className="text-faint">{Math.round(world.ramAllocation / 1024)} GB · {wMetrics.worldSize > 0 ? humanSize(wMetrics.worldSize) : '—'} on disk · {world.lastPlayedAt ? timeAgo(world.lastPlayedAt) : 'Never'}</span>
                    {world.assignedServer && (
                      <span className="text-faint">Server: {world.assignedServer.ip}</span>
                    )}
                  </div>
                </div>

                {/* Right rail — Play + overflow actions */}
                <div className="flex shrink-0 items-center gap-2">
                  {!world.broken && onPlayWorld && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayWorld(world.id);
                      }}
                      disabled={isLoading}
                      className="rounded-[8px] border border-white/[0.08] px-4 py-1.5 text-[12px] font-medium text-dim transition-all duration-micro hover:border-ember/30 hover:bg-ember/10 hover:text-ember disabled:opacity-30 disabled:hover:border-white/[0.08] disabled:hover:bg-transparent disabled:hover:text-dim"
                    >
                      Play
                    </button>
                  )}
                {/* Overflow menu — all worlds. Managed worlds get a trimmed
                    menu (Mod Manager / Back up / Backups only) since rename,
                    duplicate and delete are main-process-forbidden for them. */}
                {!isRenaming && !isDeleting && (
                  <div className="relative shrink-0" ref={menuOpenId === world.id ? menuRef : null}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === world.id ? null : world.id);
                      }}
                      disabled={isLoading}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors duration-micro hover:bg-white/[0.05] hover:text-dim disabled:opacity-30"
                      aria-label="World actions"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="19" r="1.5" />
                      </svg>
                    </button>
                    {menuOpenId === world.id && (
                      <div className="glass absolute right-0 top-full mt-1 z-50 rounded-[10px] p-1 min-w-[140px]">
                        {!isManaged && (
                        <button
                          onClick={() => { setMenuOpenId(null); setRenamingId(world.id); setRenameValue(world.name); }}
                          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-dim transition-colors hover:text-ink hover:bg-white/[0.03]"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M11 4H4v16h16v-7M18.5 2.5l3 3L11 16l-4 1 1-4 12.5-12.5z" /></svg>
                          Rename
                        </button>
                        )}
                        {!isManaged && (
                        <button
                          onClick={() => handleDuplicate(world.id)}
                          disabled={isLoading}
                          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-dim transition-colors hover:text-ink hover:bg-white/[0.03] disabled:opacity-30"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M4 16V4h12" /></svg>
                          Duplicate
                        </button>
                        )}
                        <button
                          onClick={() => handleBackup(world.id)}
                          disabled={isLoading}
                          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-dim transition-colors hover:text-ink hover:bg-white/[0.03] disabled:opacity-30"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path d="M12 7v5l3 3" /></svg>
                          Back up
                        </button>
                        <button
                          onClick={() => {
                            setModManagerWorld({ id: world.id, name: world.name });
                            setMenuOpenId(null);
                          }}
                          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-dim transition-colors hover:bg-white/[0.04] hover:text-ink"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" /><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" /></svg>
                          Mod Manager
                        </button>
                        <button
                          onClick={() => toggleBackups(world.id)}
                          disabled={isLoading}
                          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-dim transition-colors hover:text-ink hover:bg-white/[0.03] disabled:opacity-30"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M3 7h18M3 12h18M3 17h18" /></svg>
                          Backups{backups > 0 ? ` (${backups})` : ''}
                        </button>
                        {world.broken && (
                          <button
                            onClick={async () => {
                              setActionLoading(world.id);
                              const result = await window.electronAPI.repairWorld(world.id);
                              setActionLoading(null);
                              if (result.success) {
                                onWorldsChanged();
                              } else {
                                setError(result.error || 'Repair failed');
                                setTimeout(() => setError(null), 3000);
                              }
                              setMenuOpenId(null);
                            }}
                            disabled={isLoading}
                            className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-ember transition-colors hover:bg-ember/10 disabled:opacity-30"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" /></svg>
                            Repair
                          </button>
                        )}
                        {!isManaged && (
                        <>
                        <div className="h-px bg-line my-1" />
                        <button
                          onClick={() => { setMenuOpenId(null); setDeletingId(world.id); }}
                          disabled={isLoading}
                          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-left text-[12px] text-danger/80 transition-colors hover:text-danger hover:bg-danger/[0.04] disabled:opacity-30"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                          Delete
                        </button>
                        </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                </div>

                {/* Loading spinner */}
                {isLoading && (
                  <div className="shrink-0">
                    <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
                  </div>
                )}
              </div>

              {/* Delete confirmation — inline, not a modal */}
              {isDeleting && (
                <div className="rise flex items-center gap-3 px-3 py-3 pl-7">
                  <p className="text-[12px] text-dim">
                    Delete <span className="text-ink font-medium">{world.name}</span>? This can&rsquo;t be undone.
                  </p>
                  <button
                    onClick={() => handleDelete(world.id)}
                    disabled={isLoading}
                    className="rounded-full bg-danger/10 px-3 py-1.5 text-[11px] font-medium text-danger transition-colors hover:bg-danger/20"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setDeletingId(null)}
                    className="text-[11px] text-faint hover:text-dim"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Backup message — ephemeral feedback */}
              {backupMessage && expandedBackupsId === world.id && (
                <div className="rise px-3 pl-7 pb-2">
                  <p className={`text-[11px] ${backupMessage.includes('fail') || backupMessage.includes('Failed') ? 'text-danger/70' : 'text-ok/60'}`}>
                    {backupMessage}
                  </p>
                </div>
              )}

              {/* Backup browser — expandable section below the row */}
              {expandedBackupsId === world.id && (
                <div className="rise px-3 pl-7 pb-3">
                  {backupsList.length === 0 ? (
                <p className="text-[11px] text-faint py-2">No backups yet. Use "Back up" in the menu to create one.</p>
                  ) : (
                <div className="flex flex-col gap-1">
                  {backupsList.map((backup) => {
                    const isRestoringThis = restoringBackup === backup.name;
                    const isDeletingThisBackup = actionLoading === `${world.id}-${backup.name}`;
                    return (
                      <div key={backup.name} className="flex items-center gap-3 rounded-[8px] px-3 py-2 transition-colors hover:bg-white/[0.02]">
                        {/* Backup icon */}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeLinecap="round" className="shrink-0">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>

                        {/* Date + size */}
                        <div className="flex flex-1 flex-col">
                          <span className="text-[12px] text-dim">{new Date(backup.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="font-mono text-[10px] tabular-nums text-faint">{humanSize(backup.size)}</span>
                        </div>

                        {/* Actions */}
                        {isRestoringThis ? (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-dim">Replace current saves?</span>
                            <button
                              onClick={() => handleRestore(world.id, backup.name)}
                              disabled={isLoading}
                              className="rounded-full bg-ember/10 px-2.5 py-1 text-[10px] font-medium text-ember transition-colors hover:bg-ember/20"
                            >
                              Restore
                            </button>
                            <button
                              onClick={() => setRestoringBackup(null)}
                              className="text-[10px] text-faint hover:text-dim"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : deletingBackup === backup.name ? (
                          /* Inline confirm — same grammar as the world-delete
                             confirmation above. A backup IS the user's rollback;
                             deleting one is irreversible and was the only
                             destructive action in the app without a confirm. */
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-dim">Delete this backup?</span>
                            <button
                              onClick={() => handleDeleteBackup(world.id, backup.name)}
                              disabled={isLoading}
                              className="rounded-full bg-danger/10 px-2.5 py-1 text-[10px] font-medium text-danger transition-colors hover:bg-danger/20"
                            >
                              Delete
                            </button>
                            <button
                              onClick={() => setDeletingBackup(null)}
                              className="text-[10px] text-faint hover:text-dim"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : isDeletingThisBackup ? (
                          <span className="text-[10px] text-faint">Deleting…</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setRestoringBackup(backup.name)}
                              disabled={isLoading}
                              className="rounded-full px-2.5 py-1 text-[10px] font-medium text-dim transition-colors hover:text-ink hover:bg-white/[0.04] disabled:opacity-30"
                            >
                              Restore
                            </button>
                            <button
                              onClick={() => setDeletingBackup(backup.name)}
                              disabled={isLoading}
                              className="rounded-full px-2 py-1 text-[10px] text-faint transition-colors hover:text-danger hover:bg-danger/[0.04] disabled:opacity-30"
                              aria-label="Delete backup"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}

        {/* New world */}
        <div className="hairline-t h-px" />
        <button
          onClick={() => setShowNewDialog(true)}
          className="group flex items-center gap-4 py-4 pl-3 pr-4 text-left transition-colors duration-micro"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth={1.5} strokeLinecap="round" className="transition-colors duration-micro group-hover:stroke-[var(--dim)]">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <span className="text-[14px] font-medium text-faint transition-colors duration-micro group-hover:text-dim">
            New world
          </span>
        </button>
      </div>

      {/* New World dialog */}
      {showNewDialog && (
        <NewWorldDialog
          onClose={() => setShowNewDialog(false)}
          onCreated={() => {
            setShowNewDialog(false);
            onWorldsChanged();
          }}
        />
      )}

      {/* Modpack confirm dialog */}
      {pendingModpack && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => !importing && setPendingModpack(null)} />
          <div className="surface panel-in relative m-4 w-full max-w-[420px] rounded-[18px] p-8">
            <button onClick={() => !importing && setPendingModpack(null)} className="absolute right-5 top-4 text-[18px] text-faint hover:text-ink">&times;</button>
            <p className="microlabel mb-3">Modpack Detected</p>
            <h2 className="font-display text-[24px] font-bold tracking-[-0.03em] text-ink">{pendingModpack.name}</h2>
            <p className="mt-3 text-[13px] text-dim">
              Minecraft {pendingModpack.minecraft} · {pendingModpack.loader ? `Fabric ${pendingModpack.loader}` : 'Vanilla'}
            </p>
            <p className="mt-1 text-[13px] text-faint">This will create a new instance with the correct version and loader.</p>
            <button
              disabled={importing}
              onClick={async () => {
                setImporting(true);
                const result = await window.electronAPI.createWorld({
                  name: pendingModpack.name,
                  version: pendingModpack.minecraft,
                  loader: pendingModpack.loader ? 'fabric' : 'vanilla',
                  loaderVersion: pendingModpack.loader || undefined,
                  ramAllocation: 4096,
                  modpackPath: pendingModpack.filePath,
                });
                setImporting(false);
                if (result.success) {
                  setPendingModpack(null);
                  onWorldsChanged();
                  // Honest partial-failure reporting: a .mrpack whose files[]
                  // could not all download still lands, but the user must
                  // know — silence would repeat the old half-installed lie.
                  if (result.modpackNotice) {
                    setError(result.modpackNotice);
                  }
                } else {
                  setError(result.error || 'Failed to create world');
                }
              }}
              className="pill-ember mt-6"
            >
              {importing ? 'Creating...' : 'Create Instance'}
            </button>
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 rounded-[10px] bg-danger/20 px-4 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {/* Mod Manager modal */}
      {modManagerWorld && (
        <ModManagerModal
          worldId={modManagerWorld.id}
          worldName={modManagerWorld.name}
          onClose={() => setModManagerWorld(null)}
        />
      )}
    </div>
  );
};

export default WorldsView;