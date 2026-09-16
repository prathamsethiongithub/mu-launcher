import React from 'react';

/**
 * The last line of defence — a render-time throw anywhere in the tree.
 *
 * Why this exists: the renderer is a single React root with no boundary, so
 * any throw during render unmounts the whole tree and leaves a PERMANENT BLACK
 * WINDOW with no recovery path short of killing the process. That exact failure
 * class has already been hit once (a missing preload bridge made
 * `window.electronAPI.isGameRunning()` undefined and blanked the app for
 * months). A boundary turns "black screen, no way back" into "one click and
 * you are back".
 *
 * Law 5 (motion is grammar): same eyebrow → hero word → sub → one action
 * structure as every other screen, so even the failure state is the product.
 * Law 1 (one ember per screen): the Reload pill is the single ember element.
 *
 * Deliberately does NOT use window.electronAPI — a boundary that depends on
 * the bridge it may be reporting on is useless. Reload is a plain location
 * reload, which re-runs main's startup reconciliation from disk.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the detail in the log for diagnosis; the user gets the calm screen.
    console.error('[renderer] Unrecoverable render error:', error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 px-10 text-center">
        <p className="microlabel !text-faint">Master Launcher</p>
        <h1 className="max-w-[14ch] text-center font-display text-[56px] font-bold leading-[1.04] tracking-[-0.04em] text-ink [text-wrap:balance]">
          Hit a snag.
        </h1>
        <p className="max-w-[52ch] text-[14px] leading-relaxed text-dim">
          Something in the interface stopped unexpectedly. Your accounts and
          worlds are untouched — reloading puts things back.
        </p>
        <button className="pill-ember mt-4" onClick={() => location.reload()}>
          Reload
        </button>
        <details className="mt-8 max-w-[70ch] text-left">
          <summary className="microlabel cursor-pointer !text-faint">Details</summary>
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-faint">
            {error.message || String(error)}
          </p>
        </details>
      </div>
    );
  }
}

export default ErrorBoundary;
