import React, { useState, useEffect, useCallback, useRef } from 'react';

type AuthViewState =
  | 'checking'       // Checking initial auth status
  | 'signed-out'     // Not logged in, showing sign-in button
  | 'signing-in'     // Popup is open, waiting for user to complete
  | 'signed-in'      // Logged in, showing profile
  | 'error';         // Error occurred

/**
 * Account view on the EMBER grammar: eyebrow → display word → sub → action.
 * The ember pill appears only when signing in is the primary action.
 */
const AuthView: React.FC = () => {
  const [viewState, setViewState] = useState<AuthViewState>('checking');
  const [profileName, setProfileName] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkAuthStatus();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.getAuthStatus();
      if (status.loggedIn && status.profile) {
        setProfileName(status.profile.name);
        setViewState('signed-in');
      } else {
        setViewState('signed-out');
      }
    } catch {
      setErrorMessage('Failed to check authentication status.');
      setViewState('error');
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const status = await window.electronAPI.getAuthStatus();
        if (status.loggedIn && status.profile) {
          setProfileName(status.profile.name);
          setViewState('signed-in');
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }
      } catch {
        // Continue polling on transient errors
      }
    }, 1000);
  }, []);

  const handleSignIn = useCallback(async () => {
    setViewState('signing-in');
    setErrorMessage('');
    try {
      const result = await window.electronAPI.startLogin();
      if (!result.success) throw new Error(result.error || 'Sign in failed to start.');
      startPolling();
    } catch (err) {
      setErrorMessage(`Failed to start sign in: ${err instanceof Error ? err.message : String(err)}`);
      setViewState('error');
    }
  }, [startPolling]);

  const handleLogout = useCallback(async () => {
    try {
      await window.electronAPI.logout();
      setProfileName('');
      setViewState('signed-out');
    } catch {
      setErrorMessage('Failed to log out.');
      setViewState('error');
    }
  }, []);

  const hero =
    viewState === 'checking' ? '' :
    viewState === 'signed-out' ? 'Sign in.' :
    viewState === 'signing-in' ? 'One moment.' :
    viewState === 'signed-in' ? `${profileName}.` :
    'Sign-in snag.';

  const sub =
    viewState === 'signed-out'
      ? 'Use the Microsoft account that owns Minecraft. We never see your password.'
      : viewState === 'signing-in'
        ? 'A Microsoft window has opened — finish signing in there and you’ll land right back here.'
        : viewState === 'signed-in'
          ? 'You’re signed in and ready. The launcher will remember you next time.'
          : errorMessage;

  if (viewState === 'checking') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="dot-breathe h-[6px] w-[6px] rounded-full bg-ember" />
        <p className="microlabel">Checking session</p>
      </div>
    );
  }

  return (
    <div className="relative z-[1] flex h-full flex-col items-center justify-center px-10">
      <p className="rise microlabel mb-6 !text-faint">Account</p>

      <h1
        key={hero}
        className="rise d1 max-w-[16ch] text-center font-display text-[56px] font-bold leading-[1.04] tracking-[-0.04em] text-ink [text-wrap:balance]"
      >
        {hero}
      </h1>

      <p
        key={sub}
        className={`rise d2 mt-5 max-w-[48ch] text-center text-[14px] leading-relaxed ${viewState === 'error' ? 'text-danger/90' : 'text-dim'}`}
      >
        {sub}
      </p>

      <div className="rise d3 mt-10 flex items-center gap-3">
        {viewState === 'signed-out' && (
          <button className="pill-ember" onClick={handleSignIn}>Sign in with Microsoft</button>
        )}
        {viewState === 'signing-in' && (
          <>
            <div className="dot-breathe h-[6px] w-[6px] rounded-full bg-ember" />
            <button className="pill-ghost" onClick={() => setViewState('signed-out')}>Cancel</button>
          </>
        )}
        {viewState === 'signed-in' && (
          <>
            <span className="flex items-center gap-2 text-[12px] text-dim">
              <span className="h-[6px] w-[6px] rounded-full bg-ok" />
              Signed in
            </span>
            <button className="pill-ghost" onClick={handleLogout}>Sign out</button>
          </>
        )}
        {viewState === 'error' && (
          <button
            className="pill-ember"
            onClick={() => { setViewState('signed-out'); setErrorMessage(''); }}
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
};

export default AuthView;
