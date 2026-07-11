# REPORT-001 — Launch State Reset (BUG-001)

**Date:** 2026-07-10
**Author:** Release QA
**Priority:** P1 (fix before release — broken experience, not a hard block)
**Status:** FIXED (static + build verified; runtime E2E pending)

## Issue Summary
When a launch is in progress and the user navigates away from the Play view and back, the launch-progress UI resets to idle while the real launch continues and Minecraft still starts.

## Observed Behavior
1. Press Play → launch begins, progress steps render and advance.
2. Navigate to Auth, then back to Play.
3. Progress UI is gone (idle "▶ Play" button shown).
4. Backend launch continues; Minecraft still launches.

## Expected Behavior
Returning to Play mid-launch shows the current progress (completed steps ✓, active step spinning), keeps updating live, and ends at "Running".

## Reproduction Steps
`npm run dev` → sign in → Play → during "Downloading Minecraft", click Auth, wait ~5–10s, click Play.

## Evidence
- `src/renderer/components/PlayView.tsx` (pre-fix): launch state held in local `useState` (`launching`, `launchSteps`, `launchError`, `isRunning`, lines 26–29); unmount `useEffect` cleanup called `window.electronAPI.removeLaunchListeners()`.
- `src/renderer/App.tsx` (pre-fix): `renderView()` `switch` mounts only the active view, so navigation **unmounts** `PlayView`.
- `src/main/index.ts:192–196`: progress originates in the main process via `mainWindow.webContents.send('launch-step', …)`; `launchManager` is a main-process module singleton (line 13) → backend keeps running regardless of renderer.

## Root Cause
Launch state and the `'launch-step'` IPC listener lived **inside `PlayView`**. Because `App` swaps views by unmounting, navigating away destroyed the state and detached the listener; events emitted while away were dropped, and the remounted `PlayView` started from empty/idle state. The main-process singleton kept launching, explaining "backend continues / Minecraft still launches."

## Files Involved
- `src/renderer/App.tsx` (fix)
- `src/renderer/components/PlayView.tsx` (fix)
- `src/main/index.ts`, `src/main/launch-service.ts`, `src/preload/index.ts` (context only — unchanged)

## Implementation
- Lifted `launching / launchError / launchSteps / isRunning` into `App` (never unmounts).
- Registered the `'launch-step'` listener **once** at app scope; teardown only on app unmount.
- `PlayView` is now props-driven (`launching, launchError, launchSteps, isRunning, onPlay, onRetry`); it no longer owns launch state or the listener, and no longer tears the listener down on navigation.
- Added a `launchingRef` re-entry guard in `App.startLaunch`.
- Side benefit: removed a per-Play listener leak (old `registerStepListener()` added a new `ipcRenderer.on` every Play).
- UI markup unchanged.

## Verification
- `npx tsc --noEmit` → 0 errors in `App.tsx` / `PlayView.tsx`.
- `npm run build` (electron-vite) → success.
- Manual (pending on a real machine): follow Reproduction Steps → progress persists across navigation and completes to "Running"; exactly one Minecraft window.

## Regression Risk
Low. No UI/markup change; error + Retry paths preserved (also lifted, so they persist across navigation). Also fixes a listener leak. Only structural: view components no longer own cross-view state.

## Next Actions
- Runtime E2E on a real machine: TEST-002 (navigation during launch), TEST-001 (Play spam).
- Confirm `is-game-running` interplay (see PROJECT_STATE — TEST-004 open).
