import React, { ReactNode } from 'react';

interface LayoutProps {
  children: ReactNode;
  version?: string;
  /** The nav rail, rendered in a reserved bottom slot so it participates in
   *  layout instead of floating over content (overflow law). */
  nav?: ReactNode;
}

/**
 * The stage frame: a hairline top bar (wordmark left, version right) above
 * the view, and the nav rail in a reserved bottom slot. main scrolls when
 * a view is taller than the window (min sizes 900x600) so nothing can ever
 * be clipped away by overflow:hidden. overflow-x guards the ambient layers
 * (PlayView's SideRays mounts at -mx-10) from opening a horizontal scrollbar.
 * main is a plain block: the keep-alive wrappers are h-full blocks stacked by
 * display:none — a flex main would shrink them to content width instead.
 */
const Layout: React.FC<LayoutProps> = ({ children, version, nav }) => {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden text-ink">
      <header className="hairline-b relative z-10 flex h-12 shrink-0 items-center justify-between px-6">
        <div className="flex items-baseline gap-2.5">
          <span className="microlabel !text-ink">Masters&rsquo; Union</span>
          <span className="microlabel !text-faint">SMP</span>
        </div>
        {version && (
          <span className="font-mono text-[11px] tabular-nums text-faint">v{version}</span>
        )}
      </header>

      <main className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</main>

      {nav && (
        <div className="relative z-10 flex shrink-0 items-center justify-center pb-3 pt-1">
          {nav}
        </div>
      )}
    </div>
  );
};

export default Layout;
