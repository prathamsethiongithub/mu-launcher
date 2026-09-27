# 31 — Release Packaging

**Mission:** produce the first downloadable Ember for Windows — NSIS installer +
portable exe, a tag-triggered release workflow, and a README that a stranger can
act on.

**Status:** config, workflow, README and both artifacts done and verified **locally**.
The tag has **not** been pushed and CI has **not** been run (that publishes a public
release — it needs an explicit go-ahead). Nothing here changes features or UI.

---

## What was built

| Piece | Before | After |
| --- | --- | --- |
| `package.json` version | `1.0.0` | **`0.1.0`** |
| `electron-builder.yml` `asar` | absent | **`asar: true`** |
| `electron-builder.yml` targets | `nsis` only | **`nsis` + `portable`** |
| artifact naming | one shared `${productName}-${version}-${arch}.${ext}` | **per-target, distinct** |
| `.github/workflows/release.yml` | did not exist | **tag `v*` → build both → GitHub pre-release** |
| `.github/workflows/build.yml` | triggered on `main` (a branch that doesn't exist) | triggers on **`master`** |
| `README.md` | internal status/handoff doc | **public install guide + receipts** |
| screenshots | none | `docs/screenshots/play.png`, `worlds.png` (real app, scripted) |

---

## Decisions and why

### version 1.0.0 → 0.1.0

The mission asked for tag `v0.1.0-friends-and-family` but `package.json` said
`1.0.0`. Since artifacts are named from `${version}` and the tag is a *friends and
family pre-release*, `1.0.0` would have been a lie told in two places. The version
was moved to `0.1.0` so the tag, the artifact filenames (`Ember-0.1.0-Setup.exe`)
and the intent all agree. `private: true` stays — this is not an npm package.

### `asar: true`

Requested as a security best practice and it is: the main/renderer bundles become a
single opaque archive instead of a browsable tree. Electron reads inside asar
transparently through its `fs` shim, and the app loads its renderer over `file://`
assets inside the same archive, so no runtime path changed. Verified by actually
producing and inspecting a build, not by assuming.

### the portable target needed distinct artifact names

`artifactName` is `${productName}-${version}-${arch}.${ext}`. NSIS and portable
both produce a `.exe`, so both targets would have written
`Ember-0.1.0-x64.exe` and **collided**. Each target now overrides `artifactName`
(`…-Setup.exe`, `…-Portable.exe`). This is the kind of thing that only shows up
when you actually run the packaging step.

### `release.yml` uses the `gh` CLI, not a third-party release action

`gh` is preinstalled on GitHub runners, so the workflow adds **zero** third-party
actions beyond the standard `actions/*`. Fewer moving parts to debug from the
Actions tab, which the mission explicitly asked for. The release is published as a
**pre-release** with honest notes ("first release. 10 users. tell us what breaks.")
and the `upload-artifact` step is kept so a failed release still leaves downloadable
artifacts to inspect.

### `build.yml` pointed at a branch that does not exist

It triggered on `main`; this repo's branch is `master`. The build workflow has
therefore never run. Fixed to `master` — a one-word change, squarely in "CI must
actually work", not a feature change.

### README

Rewritten for a stranger, in the product's own lowercase voice. It states the
unsigned/SmartScreen reality up front with the exact unblock steps, and its claims
are all checkable in the repo (374 unit tests, 12 e2e specs, `crash-diagnostic.ts`,
truth doc 29). The screenshots are produced by `scripts/capture-screenshots.mjs`,
which boots the **real built app** on a scratch profile — no mockups.

---

## Artifacts produced locally (verified)

```
dist/Ember-0.1.0-Setup.exe        107,491,065 bytes   NSIS, x64
dist/Ember-0.1.0-Portable.exe     107,271,219 bytes   portable, x64
dist/Ember-0.1.0-Setup.exe.blockmap
dist/latest.yml                                       electron-updater feed
```

Both built from the current tree (`red-team`, atop `cd17f58` / master) with
`npx electron-builder --win --publish never`.

**Observed flakiness (honest, not hidden):** the first two invocations failed with
`EBUSY: resource busy or locked … dist\win-unpacked\Ember.exe` during electron-
builder's "updating asar integrity executable resource" step — a lock on the freshly
extracted exe, the usual Windows real-time-scan behaviour. The third invocation
succeeded with no changes. **Mitigation: retry the packaging step.** A slower fix
(if it becomes chronic) is a Defender exclusion for the repo's `dist/`; the CI
runner is not expected to hit this, and if it ever does, re-running the job is the
correct response. This is recorded rather than glossed because "it built once" and
"it builds reliably" are different claims.

---

## Deferred, on purpose

| Deferred | Why | Where it would go |
| --- | --- | --- |
| **Code signing** | a cert costs money per year; this is a launcher for one SMP's first 10 users | `win.certificateFile` / `CSC_LINK` + a secrets entry in `release.yml` |
| **Auto-update feed** | `electron-updater` is a dependency and `latest.yml` is produced, but the update path has not been verified against a real published release | already wired via the `publish` block; needs a real release + a second version to prove |
| **macOS / Linux** | Windows is the only supported platform | out of scope |
| **Push the tag** | creating a public release is irreversible and outward-facing | `git push origin v0.1.0-friends-and-family` — **needs the director's go-ahead** |

`electron-updater` being present while the feed is unproven is a **known gap**, not a
claim: nothing in this release pretends auto-update works.

---

## Iron rules — respected

- **No feature changes, no UI changes.** The only source file touched is
  `package.json`'s `version` field.
- **No new runtime dependencies.** `release.yml` adds no third-party actions;
  the screenshot script uses the existing `playwright` devDependency.
- **Build comes from current master** (`cd17f58` + wave-B work, not yet merged).

---

## Verification

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | 374 passed / 25 files |
| `npm run build` | clean — `out/main/index.js`, preload, renderer assets |
| `npx electron-builder --win --publish never` | **both artifacts produced** (sizes above) |
| YAML validity (all 3 workflows + `electron-builder.yml`) | parsed clean with `js-yaml` |
| `release.yml` trigger | `push.tags: ['v*']`, 9 steps |
| `npm run lint` | **pre-existing failure**: 20 errors / 334 warnings, all in files this mission did not touch (e.g. `src/types/adm-zip.d.ts`). Wave B changed no `src/` file, so this is the repo's baseline. See the CI note below. |
| clean-machine install test | **not run** — no clean Windows 10 machine available in this environment; the local host is Windows 11. Recorded as unverified. |

### CI note: why `release.yml` does not run lint

`release.yml` runs `typecheck` + `npm test` + `build` + package, and deliberately
**not** `npm run lint`, because lint currently fails on the repo's baseline (above).
If lint were a release gate today, no release could ever be cut — and fixing 20
pre-existing lint errors is not packaging work. `build.yml` and `lint.yml` still run
lint, so the debt stays visible on every push; the release path is not blocked by
an unrelated pre-existing failure. Fixing it is its own ticket.
