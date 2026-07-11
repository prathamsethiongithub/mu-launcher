# DEBUG-001 — Launch State Reset investigation

**Timestamp:** 2026-07-10 (session order #1)
**Objective:** Find why launch progress UI resets when navigating Play → Auth → Play while the backend launch keeps running.

**Hypothesis:** Launch state and/or the progress IPC listener live inside the Play view component and are destroyed on navigation (unmount).

**Investigation:**
- Read `src/main/index.ts` — `launchManager` is a main-process module singleton; `launch-game` handler sends `'launch-step'` via `webContents.send`. Backend independent of renderer. ✔ explains "Minecraft still launches".
- Read `src/renderer/App.tsx` — `renderView()` is a `switch` that returns exactly one view → navigation unmounts the previous view.
- Read `src/renderer/components/PlayView.tsx` — launch state in local `useState` (26–29); mount `useEffect` cleanup calls `removeLaunchListeners()`; listener registered inside `handlePlay` via `registerStepListener()`.
- Read `src/preload/index.ts` — `onLaunchStep` = `ipcRenderer.on('launch-step', …)`; `removeLaunchListeners` = `removeAllListeners('launch-step')`.

**Evidence:** On unmount, PlayView drops local state AND detaches the `'launch-step'` listener; events during navigation are lost; remount starts idle. Also found: `registerStepListener()` adds a new listener every Play (leak).

**Conclusion:** Root cause = launch state stored locally in a component that unmounts on navigation, plus the listener attached/detached in that component's lifecycle. Confirmed, not a backend issue.

**Result:** Fixed in App.tsx / PlayView.tsx (lift state + single app-scope listener). See REPORT-001. Typecheck clean on both files; build green. Runtime E2E still pending.
