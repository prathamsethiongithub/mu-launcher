import React, { useState, useEffect, useCallback } from 'react';
import SkinViewerCanvas from './fx/SkinViewerCanvas';

interface AccountData {
  id: string;
  type: 'microsoft' | 'offline';
  username: string;
  uuid?: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Enriched by the get-accounts handler: whether a session exists. */
  hasSession?: boolean;
}

interface PendingSkin {
  dataUrl: string;
  width: number;
  height: number;
}

/** Map the upload variant (Mojang's language) to skinview3d's model. */
const toViewerModel = (variant: 'classic' | 'slim'): 'default' | 'slim' =>
  variant === 'slim' ? 'slim' : 'default';

const IdentityView: React.FC = () => {
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [showOfflineDialog, setShowOfflineDialog] = useState(false);
  const [offlineName, setOfflineName] = useState('');
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [msLoading, setMsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Identity Studio state ─────────────────────────────────────────────
  const [skinDataUrl, setSkinDataUrl] = useState<string | null>(null);
  const [skinModel, setSkinModel] = useState<'slim' | 'default'>('default');
  const [skinVariant, setSkinVariant] = useState<'classic' | 'slim'>('classic');
  const [skinLoading, setSkinLoading] = useState(false);
  const [pendingSkin, setPendingSkin] = useState<PendingSkin | null>(null);
  const [pendingVariant, setPendingVariant] = useState<'classic' | 'slim'>('classic');
  const [uploadLoading, setUploadLoading] = useState(false);
  const [skinMessage, setSkinMessage] = useState<{ text: string; tone: 'ok' | 'danger' } | null>(null);

  const flashMessage = useCallback((text: string, tone: 'ok' | 'danger') => {
    setSkinMessage({ text, tone });
    if (tone === 'ok') setTimeout(() => setSkinMessage(null), 4000);
  }, []);

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

  const loadSkin = useCallback(async (accountId: string | null, force = false) => {
    if (!accountId) {
      setSkinDataUrl(null);
      setSkinModel('default');
      return;
    }
    const account = accounts.find((a) => a.id === accountId);
    if (!account || account.type === 'offline') {
      setSkinDataUrl(null);
      setSkinModel('default');
      return;
    }

    setSkinLoading(true);
    try {
      const skin = await window.electronAPI.getIdentitySkin(accountId, force);
      if (skin?.skinUrl) {
        setSkinDataUrl(skin.skinUrl);
        const variant: 'classic' | 'slim' = skin.model === 'slim' ? 'slim' : 'classic';
        setSkinModel(toViewerModel(variant));
        setSkinVariant(variant);
      } else {
        setSkinDataUrl(null);
      }
    } catch {
      setSkinDataUrl(null);
    } finally {
      setSkinLoading(false);
    }
  }, [accounts]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // Push sync: sign-ins that originate OUTSIDE this view (Play screen,
  // startup import) would otherwise leave the registry rendering "Sign in
  // with Microsoft" until a manual navigation. The event carries no data —
  // the re-pull below reads final main-process state.
  useEffect(() => {
    window.electronAPI.onAuthChanged(() => {
      loadAccounts();
    });
    return () => window.electronAPI.removeAuthChangedListeners();
  }, [loadAccounts]);
  useEffect(() => {
    setPendingSkin(null);
    setSkinMessage(null);
    loadSkin(activeAccountId);
  }, [activeAccountId, loadSkin]);

  // ── Account actions ───────────────────────────────────────────────────

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

  const handleSwitchAccount = async (accountId: string) => {
    if (accountId === activeAccountId) return;
    setActionLoading(accountId);
    setConfirmRemoveId(null);
    try {
      await window.electronAPI.setActiveAccount(accountId);
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
    } catch {
      setError('Failed to remove account. Please try again.');
    } finally {
      setActionLoading(null);
    }
  };

  // ── Skin actions ──────────────────────────────────────────────────────

  const handleChooseSkin = async () => {
    setSkinMessage(null);
    const result = await window.electronAPI.selectSkinFile();
    if (!result) return; // dialog canceled
    if ('error' in result) {
      flashMessage(result.error, 'danger');
      return;
    }
    setPendingSkin(result);
    setPendingVariant(skinVariant);
  };

  const handleConfirmUpload = async () => {
    if (!activeAccountId || !pendingSkin) return;
    setUploadLoading(true);
    setSkinMessage(null);
    try {
      const result = await window.electronAPI.uploadSkin(activeAccountId, pendingVariant);
      if (!result.success) {
        flashMessage(result.error || 'Upload failed. Try again.', 'danger');
        return; // keep the pending skin so they can retry
      }
      setSkinDataUrl(result.skin?.skinUrl ?? pendingSkin.dataUrl);
      setSkinModel(toViewerModel(pendingVariant));
      setSkinVariant(pendingVariant);
      setPendingSkin(null);
      flashMessage('Skin updated. It’s live on your profile.', 'ok');
    } catch {
      flashMessage('Upload failed. Check your connection and try again.', 'danger');
    } finally {
      setUploadLoading(false);
    }
  };

  const handleRefreshSkin = async () => {
    if (!activeAccountId) return;
    setSkinMessage(null);
    await loadSkin(activeAccountId, true); // force — bypass the 24h cache
    flashMessage('Refreshed from Mojang.', 'ok');
  };

  // ── Derived ───────────────────────────────────────────────────────────

  const sorted = [...accounts].sort((a, b) => {
    if (a.id === activeAccountId) return -1;
    if (b.id === activeAccountId) return 1;
    return 0;
  });

  const activeAccount = accounts.find((a) => a.id === activeAccountId);
  const isMsActive = activeAccount?.type === 'microsoft';
  const isOfflineActive = activeAccount?.type === 'offline';

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="dot-breathe h-[6px] w-[6px] rounded-full bg-ember" />
        <p className="microlabel">Loading accounts</p>
      </div>
    );
  }

  return (
    <div className="relative z-[1] flex h-full flex-col items-center overflow-y-auto px-10 pt-20 pb-24">
      {/* ── Header — quiet, like the stage ─────────────────────────────── */}
      <div className="rise d1 mb-12 w-full max-w-[520px]">
        <p className="microlabel mb-3">Account</p>
        <p className="text-[14px] text-dim">
          {accounts.length === 0
            ? 'Sign in with Microsoft to step into the SMP as yourself.'
            : 'The active account enters the world when you press Play.'}
        </p>
      </div>

      {/* ── Accounts shelf — hairlines, not boxes (same language as Worlds) */}
      <div className="rise d2 flex w-full max-w-[520px] flex-col">
        {sorted.map((account, idx) => {
          const isActive = account.id === activeAccountId;
          const isMs = account.type === 'microsoft';
          const isBusy = actionLoading === account.id;
          const signedOut = isMs && account.hasSession === false;
          const confirming = confirmRemoveId === account.id;

          return (
            <React.Fragment key={account.id}>
              {idx > 0 && <div className="hairline-t h-px" />}

              <div className="group relative flex items-center gap-4 py-4 pl-3 pr-4 transition-all duration-micro">
                {/* Active rail — ember line, the same selection mark as Worlds */}
                {isActive && (
                  <span className="absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 rounded-full bg-ember" />
                )}

                <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                  {isMs ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isActive ? 'var(--dim)' : 'var(--faint)'} strokeWidth={1.5} className="transition-colors duration-micro">
                      <rect x="3" y="3" width="8" height="8" />
                      <rect x="13" y="3" width="8" height="8" />
                      <rect x="3" y="13" width="8" height="8" />
                      <rect x="13" y="13" width="8" height="8" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isActive ? 'var(--dim)' : 'var(--faint)'} strokeWidth={1.5} strokeLinecap="round" className="transition-colors duration-micro">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
                    </svg>
                  )}
                </div>

                <div className="flex flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[15px] font-semibold tracking-[-0.01em] transition-colors duration-micro ${isActive ? 'text-ink' : 'text-dim group-hover:text-ink'}`}>
                      {account.username}
                    </span>
                    <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${isMs ? 'text-dim/70' : 'text-faint'}`}>
                      {isMs ? 'Microsoft' : 'Offline'}
                    </span>
                    {signedOut && (
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                        Signed out
                      </span>
                    )}
                  </div>
                  {/* One human fact — internal identifiers stay internal */}
                  <div className="font-mono text-[10px] tabular-nums text-faint">
                    {account.lastUsedAt
                      ? `Last used ${new Date(account.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                      : `Added ${new Date(account.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                  </div>
                </div>

                {/* Row actions — type carries state; danger only inside confirm */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {isBusy ? (
                    <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
                  ) : confirming ? (
                    <>
                      <span className="mr-1 text-[11px] text-dim">Remove this account?</span>
                      <button
                        onClick={() => handleRemoveAccount(account.id)}
                        className="rounded-full px-2.5 py-1 text-[11px] font-medium text-danger transition-colors duration-micro hover:bg-danger/[0.08]"
                      >
                        Remove
                      </button>
                      <button
                        onClick={() => setConfirmRemoveId(null)}
                        className="rounded-full px-2.5 py-1 text-[11px] text-faint transition-colors duration-micro hover:text-dim"
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      {!isActive && (
                        <button
                          onClick={() => handleSwitchAccount(account.id)}
                          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-dim transition-colors duration-micro hover:bg-white/[0.04] hover:text-ink"
                        >
                          Switch
                        </button>
                      )}
                      {isActive && isMs && !signedOut && (
                        <button
                          onClick={() => handleSignOut(account.id)}
                          className="rounded-full px-2.5 py-1 text-[11px] text-faint transition-colors duration-micro hover:bg-white/[0.04] hover:text-dim"
                        >
                          Sign out
                        </button>
                      )}
                      {isActive && signedOut && (
                        <button
                          onClick={handleAddMicrosoft}
                          disabled={msLoading}
                          className="rounded-full px-2.5 py-1 text-[11px] font-medium text-dim transition-colors duration-micro hover:bg-white/[0.04] hover:text-ink disabled:opacity-40"
                        >
                          {msLoading ? 'Opening Microsoft…' : 'Sign in'}
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmRemoveId(account.id)}
                        className="rounded-full p-1.5 text-faint opacity-0 transition-all duration-micro hover:text-dim group-hover:opacity-100"
                        aria-label={`Remove ${account.username}`}
                        title="Remove account"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}

        {/* Add account — dashed invitation, never demanding */}
        {accounts.length === 0 ? (
          <div className="flex flex-col gap-3 py-4">
            <button onClick={handleAddMicrosoft} disabled={msLoading} className="pill-ember self-start">
              {msLoading ? 'Opening Microsoft…' : 'Sign in with Microsoft'}
            </button>
            <button onClick={() => setShowOfflineDialog(true)} className="pill-ghost self-start">
              Add offline account
            </button>
          </div>
        ) : (
          <>
            <div className="hairline-t h-px" />
            <div className="flex items-center gap-4 py-4 pl-3 pr-4">
              <button
                onClick={handleAddMicrosoft}
                disabled={msLoading}
                className="flex items-center gap-2 text-[13px] font-medium text-faint transition-colors duration-micro hover:text-dim disabled:opacity-30"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {msLoading ? 'Opening Microsoft…' : 'Add Microsoft account'}
              </button>
              <span className="text-faint">·</span>
              <button
                onClick={() => setShowOfflineDialog(true)}
                className="text-[13px] font-medium text-faint transition-colors duration-micro hover:text-dim"
              >
                Add offline
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Identity Studio ────────────────────────────────────────────── */}
      {(isMsActive || isOfflineActive) && (
        <div className="rise d3 mt-10 w-full max-w-[520px]">
          <div className="hairline-t mb-6 h-px" />
          <p className="microlabel mb-5">Identity Studio</p>

          {isOfflineActive ? (
            /* Offline accounts wear the default look — say so, quietly. */
            <p className="text-[13px] leading-relaxed text-faint">
              Offline accounts wear the default look. Skins live on Microsoft
              accounts — switch to one to change how you appear in the world.
            </p>
          ) : (
            <div className="flex gap-8">
              {/* Preview — always mounted; loading and pending overlay it.
                  While the account's skin resolves the viewer stays hidden
                  (never flash the default); resolved-null (no custom skin,
                  offline) shows the bundled Steve via the viewer fallback. */}
              <div className="relative h-[220px] w-[150px] shrink-0">
                <SkinViewerCanvas
                  skinUrl={skinLoading && !pendingSkin ? undefined : (pendingSkin?.dataUrl ?? skinDataUrl)}
                  model={pendingSkin ? toViewerModel(pendingVariant) : skinModel}
                />
                {skinLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
                  </div>
                )}
              </div>

              {/* Controls — progressive: upload params appear only when a
                  new skin is staged */}
              <div className="flex flex-1 flex-col justify-center gap-4">
                {pendingSkin ? (
                  <>
                    <div>
                      <p className="text-[13px] font-medium text-ink">New skin staged.</p>
                      <p className="mt-1 text-[12px] leading-relaxed text-dim">
                        This is a preview — nothing changes until you use it.
                      </p>
                    </div>

                    <div>
                      <p className="microlabel mb-2">Arm style</p>
                      <div className="flex gap-2">
                        {(['classic', 'slim'] as const).map((v) => (
                          <button
                            key={v}
                            onClick={() => setPendingVariant(v)}
                            className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors duration-micro ${
                              pendingVariant === v
                                ? 'bg-white/[0.06] text-ink'
                                : 'text-faint hover:bg-white/[0.03] hover:text-dim'
                            }`}
                          >
                            {v === 'classic' ? 'Classic' : 'Slim'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleConfirmUpload}
                        disabled={uploadLoading}
                        className="pill-ember !px-5 !py-2.5 !text-[13px] disabled:opacity-40"
                      >
                        {uploadLoading ? 'Uploading…' : 'Use this skin'}
                      </button>
                      <button
                        onClick={() => { setPendingSkin(null); setSkinMessage(null); }}
                        disabled={uploadLoading}
                        className="text-[12px] text-faint transition-colors duration-micro hover:text-dim disabled:opacity-40"
                      >
                        Keep current
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-mono text-[11px] tabular-nums text-faint">
                      {skinDataUrl
                        ? (skinVariant === 'slim' ? 'Slim' : 'Classic')
                        : 'Nothing here yet'}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleChooseSkin}
                        disabled={skinLoading}
                        className="pill-ghost !px-4 !py-2 !text-[12px] disabled:opacity-30"
                      >
                        Upload a skin
                      </button>
                      <button
                        onClick={handleRefreshSkin}
                        disabled={skinLoading}
                        className="rounded-full p-2 text-faint transition-colors duration-micro hover:bg-white/[0.03] hover:text-dim disabled:opacity-30"
                        aria-label="Refresh skin from Mojang"
                        title="Refresh from Mojang"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                          <path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" />
                        </svg>
                      </button>
                    </div>

                    <p className="text-[11px] leading-relaxed text-faint">
                      64×64 PNG. Changes apply to your Minecraft profile everywhere.
                    </p>
                  </>
                )}

                {skinMessage && (
                  <p className={`text-[11px] ${skinMessage.tone === 'danger' ? 'text-danger/80' : 'text-ok/70'}`}>
                    {skinMessage.text}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error line — words, not boxes */}
      {error && (
        <div className="rise mt-4 w-full max-w-[520px]">
          <p className="text-[12px] text-danger/80">{error}</p>
        </div>
      )}

      {/* ── Offline account dialog ─────────────────────────────────────── */}
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
