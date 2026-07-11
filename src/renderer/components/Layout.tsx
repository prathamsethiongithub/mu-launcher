import React, { ReactNode } from 'react';

interface LayoutProps {
  children: ReactNode;
  version?: string;
}

/**
 * The stage frame: a hairline top bar (wordmark left, version right) above
 * the view. Navigation lives in DockNav; atmosphere lives in .hearth.
 */
const Layout: React.FC<LayoutProps> = ({ children, version }) => {
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

      <main className="relative flex-1 overflow-hidden">{children}</main>
    </div>
  );
};

export default Layout;
