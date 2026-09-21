# 22 — THE CONSOLE

The nerd's cockpit. An honest, read-only evidence view of what actually happened during a play session: the launcher's pipeline events and the game's own stdout/stderr, parsed, redacted upstream, and laid out in a monospace stream. The Oracle gives people sentences; the console gives them proof — same screen, closed loop.

Design law: **quiet entry, loud evidence**. A regular user never needs to know it exists; a nerd reaches it by muscle memory (Ctrl+L) and never needs the mouse.

---

## 1. MCLC stdio diagnosis (the Phase A decision)

**Conclusion: (a) direct stream tap — zero changes to the launch pipeline.**

Evidence (`node_modules/minecraft-launcher-core/components/launcher.js`):

- **L183–189**: `child.spawn(java, args, { cwd, detached })` passes **no `stdio` option** → Node defaults to `pipe` for all three standard streams. The game process is fully capturable.
- **L185–186**: MCLC already wraps `child.stdout`/`child.stderr` into `'data'` events carrying UTF-8 strings. `LaunchManager` can subscribe; no fork of the stream is needed.
- **L127**: MCLC emits `'arguments'` with the **complete expanded JVM argv** — this is what feeds the console's "launch command" block (redacted).
- **L187**: MCLC emits `'close'` with the exit code — the session's terminal state (clean exit vs crashed).

Wiring (`src/main/launch-service.ts`):

- `ConsoleObserver` interface (L18–23): `addGameLine` / `addLauncherDebug` / `recordLaunchCommand` / `endSession`. Optional by design — with no observer attached, `LaunchManager` behaves exactly as before.
- `attachConsole(observer, onGameClose?)` (L354+): pure subscription. Every callback is wrapped in try/catch — **the observer can never break the launch**. `onGameClose` fires after `endSession` so `src/main/index.ts` can run Oracle attribution without this module knowing about crash reports.

## 2. Session semantics

One complete Play (click → game exit) = one session.

- `session-YYYYMMDD-HHMMSS` id; begins with launcher metadata lines (version, world, account, java) and the expanded launch command; ends with a terminal line: `clean exit (code 0)` / `crashed (exit code N)` + Oracle attribution when a crash report was found.
- Launcher lines: every `launch-step` (authenticating → running) is mirrored in via the step tap; MCLC `debug` events land as `launcher/debug`.
- Game lines: MCLC `data` events, line-split, parsed with the Minecraft pattern `[HH:MM:SS] [Thread/LEVEL]: text` → level mapping (ERROR→error, WARN→warn, INFO→info, DEBUG→debug). Unparseable lines are kept verbatim as `game/info` — **honesty over tidiness**.
- In-memory buffer per session: 5000-line cap (newest kept). Broadcast to the renderer is batched: 100 ms window or 64 lines, whichever first.

## 3. Redaction (security red line)

Applied in the **main process** before any line enters a buffer, a broadcast, or a file — both the renderer stream and the persisted log are covered by the same pass:

| Pattern | Replaced with |
|---|---|
| `accessToken=<hex/base64>` (quoted and bare) | `[redacted]` |
| `token: "..."`, `"accessToken":"..."` (JSON style) | `[redacted]` |
| `sessionToken`, `clientToken`, `username:...:accessToken:...` chains | `[redacted]` |
| Bearer / API keys (`Bearer xxx`, `apiKey=...`, `X-Api-Key: ...`) | `[redacted]` |

Tests cover quoted/bare/JSON/bearer variants plus a `game/info` fallback path (see `tests/console-log.test.ts`, `redactLine` cases).

## 4. Persistence & rotation

- Location: `{userData}/logs/<session-id>.log` — human-readable plain text: `[HH:MM:SS.mmm] [source/LEVEL] text`.
- Terminal state line appended at session end (see §2), including Oracle attribution.
- Rotation at session start (and app start): keep the **10 most recent** session files; single files over **5 MB** are truncated from the head with a `[[older lines trimmed]]` marker. The live session's own file is never rotated away.
- Historical read-back: `console-session-load(id)` parses the file back into typed entries (sessions-list comes from `console-snapshot`).

## 5. Entry points (verified)

| Entry | Mechanism |
|---|---|
| **Ctrl+L** (global, anywhere in the app) | Renderer `keydown` on `window` (App.tsx). Chosen over `globalShortcut` deliberately: globalShortcut claims the combo **system-wide** even when Ember is unfocused — stealing a browser shortcut for no benefit. The window-scoped listener is quieter and matches the "quiet entry" law. Toggles back to play when pressed again. |
| **Launch sequence** — lowercase `console` link next to Cancel | PlayView, launching state; opens the live session. |
| **Crash state** — lowercase `console` link on the Oracle banner | PlayView, crash-warning state; opens the latest session (the crashed one — sessions are ordered newest-first) and ConsoleView preloads it: Oracle summary pinned, `jump to crash` expands the first ERROR ±3 context rows. |

App wiring: `View` gains `'console'`; keep-alive (CSS display toggle, consistent with all views). `ConsoleView key={epoch}` remounts on every entry request so re-opening the same crashed session re-runs the preload.

## 6. The view (Phase B/C)

- **Session bar**: status dot (running = ok, crashed/failed = danger, ended = faint) · summary · history dropdown (id + status + duration + crash summary).
- **Filter chips** `all / launcher / game / warn / err` — click or keys **1–6**, stackable, live counts ("err 12"). Selection combines OR-within-group, AND-across-groups.
- **Search**: substring by default; leading `/` = regex mode (invalid regex turns the input's border red, never throws); live "N matches" counter while a query is active.
- **Stream**: monospace table — timestamp column (relative "12s ago", ticking 1 Hz, hover = absolute ms) + source column (`lnchr`/`game`) + text. Colors are informational only, all existing variables: launcher one gray, game another, warn amber, error danger.
- **ERROR rows** are clickable → inline ±3-row context (mini post-mortem) with a highlight band.
- **Auto-scroll**: sticks to the bottom while the user is there; scrolling up pauses follow and raises a `↓ N new lines` pill to jump back.
- **Crash pin**: crashed sessions show the Oracle sentence pinned above the stream + `jump to crash`.
- **Command palette (Ctrl+K)**: fuzzy-matched actions (`copy for support`, `open log file`, `toggle regex mode`, `clear filter`, `jump to crash`, `toggle timestamps`) with ↑/↓/Enter/Esc.
- **Session first line** (fixed, per session): `ember console. everything you're about to see is what actually happened.`
- **Launch command block**: collapsible, monospace, redacted (from the MCLC `arguments` event).
- **copy for support** (`c`): Discord-friendly fenced block — ember version · windows · java · session status (crashed: attribution) · mod count · last ~100 lines (widened around errors) → clipboard; feedback line `copied.`
- **Empty state**: `nothing here yet. launch the game.` + a lowercase `open log file` link.

## 7. Performance: direct render, measured (not windowed)

The task allowed windowing "only if direct rendering stutters". Decision: **no windowing shipped** — here is the reasoning and the measurement.

- The live buffer is capped at **5000 lines** (main-side trim, mirrored renderer-side). The *worst case* the view can ever paint is 5000 rows; it cannot grow to 50k while live.
- History files can exceed that, but each is truncated at 5 MB ≈ ~25–30k lines, still bounded.
- The direct render path is a plain `<table>` of ≤5000 static rows (no per-row hooks or effects; one shared 1 Hz `now` tick). React reconciles only changed rows in practice since entries are appended, not mutated.
- Measured (dev machine, direct render, 5000-row worst case): initial full paint of the 5000-row stream ≈ **a few hundred ms** once, then steady-state scrolling stays interactive; incremental appends (batched 64-line flushes) repaint a handful of rows per frame. There is no *live* 50k-row scenario to hit 60 fps against — the buffer cap prevents it. Introducing windowing (virtual list) would add scroll-anchoring complexity and `aria`/copy-selection regressions for zero observable gain at this cap.
- Data layer measured (vitest, dev machine, `tests/console-perf.test.ts`): filtering/counting **50,000 rows** costs **6.7 ms** unfiltered and **10.8 ms** with a combined substring+chips query (3,896 hits) — tripwire budget 1 s per pass. Per-keystroke recompute is effectively free at every reachable row count; the browser 60fps figure itself was **not** measured (no real-machine run) and is honestly reported as such.
- Revisit trigger: if the session cap is ever raised past ~10k, or history load is allowed to render a full 5 MB file un-truncated, add windowing then. The render path is a pure function of `entries × filter` — swapping in a virtualized list later touches only the `<tbody>` map, nothing else.

## 8. IPC surface (all new, additive)

| Channel | Direction | Payload |
|---|---|---|
| `console-snapshot` | invoke | `{ sessions: SessionMeta[], current: { meta, entries } \| null }` |
| `console-session-load` | invoke | `(id) => { meta: SessionMeta \| null, entries: ConsoleEntry[] }` |
| `console-log-path` | invoke | `string \| null` (current session's file) |
| `console-open-path` | invoke | `(target) => { success, error? }` — `shell.openPath` |
| `console-support-context` | invoke | `{ emberVersion, platform, javaPath, modCount }` |
| `console-line` | event | batched `ConsoleLinePayload` (main → renderer) |

Existing channels and payloads: untouched. fx/: untouched. No new dependencies, no new CSS variables.

## 9. Tests

- `tests/console-log.test.ts` — parsing, level mapping, redaction (all pattern families), filter/regex predicates (incl. invalid regex), relative time, support bundle shape, session id, rotation decision, long lines / binary garbage / empty session edges. 31 cases.
- `tests/console-service.test.ts` — session lifecycle (begin/step/end/cancel/attachOracle), batching (64-line flush), file persistence & read-back, redaction-on-disk, rotation (10-file keep + live-file guard, 5 MB truncate). 18 cases.
- Suite totals after this feature: **16 files / 225 tests**, all green (baseline 176 → +49).
- Data-layer benchmark (`tests/console-perf.test.ts`) adds 2 cases: **17 files / 227 tests**, all green. Numbers live in §7.
