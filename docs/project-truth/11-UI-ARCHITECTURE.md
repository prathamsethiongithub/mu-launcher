# 11 — UI ARCHITECTURE

Renderer views, ownership boundaries, and state flow (`CONFIRMED` by reading each component).

## Shell (`App.tsx`)

- Owns **cross-view state**: view (`View` union), launch state, worlds, active world, auth snapshot, update state.
- Renders chrome (Layout/IconSidebar/AuroraBackground/WorldSwitcher) + the active view via a switch (**unmount-on-navigate** — the fact that made launch state lift mandatory, REPORT-001).
- Registers the single app-scope `launch-step` listener; `is-game-running` pulled on mount.
- `WorldData` interface is **duplicated** in App, PlayView, WorldsView, WorldSwitcher, SettingsView (REPORT-006 gap #3 — still current, `CONFIRMED` via grep; drift risk noted there).

## Views

| View | Parent | Children | State ownership | IPC used | States handled |
|---|---|---|---|---|---|
| **PlayView** | App | PlayerIdentity (→SkinViewerCanvas), ForgeLine, world eyebrow/rail | props-only (launch/world state lifted to App; REPORT-001) | none directly (via props) | idle / launching (steps) / error+Retry / running; signed-out gate → sign-in affordance |
| **WorldsView** | App | rows, NewWorldDialog (via App), overflow menu | local UI state (dialogs, confirms); world data from App | getWorlds, setActiveWorld, create/rename/duplicate/delete, backup/restore/verify/delete-backup, checkWorldHealth, getWorldMetrics, getBackups | loading, empty ("no worlds yet"), health chips, error toasts |
| **WorldSwitcher** | App (popover) | rows | props | (inherits App data) | empty, active rail |
| **NewWorldDialog** | App | form | local form state | createWorld | validation errors, memory options, templates |
| **IdentityView** | App | SkinViewerCanvas (studio preview), account rows | local staging state (staged skin, arm style, confirm steps) | getAccounts, getActiveAccount, setActiveAccount, addMicrosoft/Offline, removeAccount, identitySignOut, getIdentitySkin, selectSkinFile, uploadSkin, validateSession | signed-out chip, offline studio empty state, remove two-step confirm, upload preview/confirm |
| **SettingsView** | App | manifest rows | props (active world) | (reads App-provided world) | "—" placeholders when unknown; no writable settings |
| **Launch/Progress** | within PlayView (ForgeLine) | step list | App-owned launchSteps | (via events) | step statuses, error card |

## Ownership boundaries (the load-bearing rule)

- **View components never own cross-view state** — a consequence of unmount-on-navigate (REPORT-001 regression history).
- **Main owns all truth** (identity/worlds/launch); renderer holds mirrors refreshed by explicit re-fetch or events.
- **fx/ components are presentation+animation brains**, not data owners: SkinViewerCanvas owns viewer lifecycle; PlayerDirector owns pose/light policy; neither performs IPC (PlayerIdentity is the bridge).

## Navigation

IconSidebar (App `View` state) — no router library. Deep-links/back-stack do not exist (`CONFIRMED`). `DockNav.tsx` is not referenced by Layout (superseded; see 02-FILE-MAP dead list).
