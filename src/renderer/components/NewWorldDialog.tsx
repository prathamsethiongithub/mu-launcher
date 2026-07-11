import React, { useState } from 'react';

interface NewWorldDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

type LoaderChoice = 'vanilla' | 'fabric';

const NewWorldDialog: React.FC<NewWorldDialogProps> = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [loader, setLoader] = useState<LoaderChoice>('vanilla');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Give your world a name.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await window.electronAPI.createWorld({
        name: name.trim(),
        version: '26.1.2',
        loader,
        loaderVersion: loader === 'fabric' ? '0.19.3' : undefined,
        ramAllocation: 4096,
      });
      if (!result.success) {
        setError(result.error || 'Failed to create world.');
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create world.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="surface panel-in relative m-4 w-full max-w-[420px] rounded-[18px] p-8">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-5 top-4 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
          aria-label="Close"
        >
          &times;
        </button>

        <p className="microlabel mb-3">New World</p>
        <h2 className="font-display text-[24px] font-bold tracking-[-0.03em] text-ink">
          Make a space of your own.
        </h2>

        {/* Name */}
        <div className="mt-6">
          <label className="microlabel mb-2 block">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="My Survival World"
            className="w-full rounded-[10px] border border-line bg-white/[0.03] px-4 py-3 text-[14px] text-ink placeholder:text-faint focus:border-ember/30 focus:outline-none transition-colors duration-micro"
            autoFocus
          />
        </div>

        {/* Loader choice — two cards, vanilla pre-selected */}
        <div className="mt-5">
          <label className="microlabel mb-2 block">Type</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setLoader('vanilla')}
              className={`flex flex-col items-start gap-1 rounded-[12px] border p-4 transition-all duration-micro ${
                loader === 'vanilla'
                  ? 'border-ember/30 bg-ember/[0.04]'
                  : 'border-line-strong bg-transparent hover:bg-white/[0.02]'
              }`}
            >
              <span className="text-[13px] font-semibold text-ink">Vanilla</span>
              <span className="text-[11px] text-dim">Latest, no mods</span>
            </button>
            <button
              onClick={() => setLoader('fabric')}
              className={`flex flex-col items-start gap-1 rounded-[12px] border p-4 transition-all duration-micro ${
                loader === 'fabric'
                  ? 'border-ember/30 bg-ember/[0.04]'
                  : 'border-line-strong bg-transparent hover:bg-white/[0.02]'
              }`}
            >
              <span className="text-[13px] font-semibold text-ink">Modded</span>
              <span className="text-[11px] text-dim">Fabric mods</span>
            </button>
          </div>
        </div>

        {/* Version hint — what it runs on; machine tuning lives in Setup */}
        <p className="mt-4 font-mono text-[11px] tabular-nums text-faint">
          MC 26.1.2{loader === 'fabric' ? ' · Fabric 0.19.3' : ''}
        </p>

        {/* Error */}
        {error && (
          <p className="mt-4 text-[12px] text-danger/90">{error}</p>
        )}

        {/* Actions */}
        <div className="mt-7 flex items-center gap-3">
          <button
            className="pill-ghost"
            onClick={onClose}
            disabled={creating}
          >
            Cancel
          </button>
          <button
            className="pill-ember"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewWorldDialog;