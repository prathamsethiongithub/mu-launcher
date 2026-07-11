/**
 * The renderer-facing type for window.electronAPI lives in src/env.d.ts —
 * a single source of truth. This file used to declare a second, stale
 * `Window.electronAPI` augmentation (11 methods, years behind the bridge),
 * which shadowed the real one in some files and caused phantom
 * "property does not exist" errors (e.g. isGameRunning in App.tsx).
 * Keep it declaration-free.
 */
export {};
