# Master Launcher

**Custom Minecraft launcher for the Masters' Union SMP. One-click join. Zero friction.**

Electron + React + TypeScript desktop launcher: Microsoft auth, automatic Java provisioning, one-click Minecraft launch with Fabric, automatic mod sync, and world management for the SMP server.

---

## Status

**Stabilization phase.** The launcher runs end-to-end (auth → Java provisioning → Fabric install → Minecraft launch) and the core chain is runtime-proven. Remaining before release: signed installer, CI build pipeline fix, real-machine Microsoft OAuth E2E. See [`PROJECT_STATE.md`](./PROJECT_STATE.md) for the authoritative status and [`RELEASE_READINESS.md`](./RELEASE_READINESS.md) for the release gate assessment.

## Quick Start

```bash
git clone https://github.com/prathamsethiongithub/mu-launcher
cd mu-launcher
npm install
npm run dev
```

### Prerequisites

- **Node.js 20+**
- **Git**
- **Windows 10/11 (x64)** — the only supported platform
- Minecraft's Java runtime is provisioned automatically by the launcher (no manual Java install needed)

## Scripts

```bash
npm run dev            # dev server with hot reload (electron-vite)
npm run build          # compile main, preload, and renderer
npm run build:electron # build + package installer (electron-builder)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src/
```

Both `npm run typecheck` and `npm run build` must pass before any change is considered done — the build (esbuild) does NOT catch everything the typecheck does.

## Project Structure

```
mu-launcher/
├── src/
│   ├── main/          # Electron main process (auth, launch, Java, mods, worlds)
│   ├── preload/       # Preload bridge (typed IPC surface)
│   ├── renderer/      # React UI (EMBER design system, see DESIGN.md)
│   └── shared/        # Shared types
├── scripts/           # Mod-list generation tooling
├── docs/              # Debug archive
├── .github/workflows/ # CI (lint active; build workflow trigger currently misconfigured)
└── electron-builder.yml
```

## Tech Stack

| Layer         | Technology                                          |
| ------------- | --------------------------------------------------- |
| Desktop Shell | [Electron](https://www.electronjs.org/)             |
| Frontend      | [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| Bundler       | [electron-vite](https://electron-vite.org/)         |
| Styling       | [Tailwind CSS](https://tailwindcss.com/)            |
| Minecraft     | [minecraft-launcher-core](https://github.com/PrismarineJS/minecraft-launcher-core) + Fabric |
| Auth          | [MSMC](https://github.com/Hanro50/MSMC) (Microsoft) |
| Packaging     | [electron-builder](https://www.electron.build/)     |

## Live Configuration (as-built — matches `src/main/launch-service.ts` + `electron-builder.yml`)

| Setting           | Value                              |
| ----------------- | ---------------------------------- |
| Product name      | Master Launcher                    |
| Repository        | `prathamsethiongithub/mu-launcher` |
| Server            | `mastersunion.minekeep.gg:25565`   |
| Minecraft version | 26.1.2 (pinned in launch-service)  |
| Fabric loader     | 0.19.3                             |
| Java runtime      | Provisioned from Mojang, SHA-1 verified, version-aware cache |
| User data         | `%APPDATA%/mu-master-launcher`     |
| Default RAM       | 4 GB                               |
| Auth              | MSMC (Microsoft OAuth) + multi-account IdentityService |
| Updates           | electron-updater → GitHub Releases |

## Documentation Map

| Doc | What it is |
| --- | ---------- |
| [`PROJECT_STATE.md`](./PROJECT_STATE.md) | **Start here.** Authoritative current status, working systems, open bugs |
| [`AGENT-HANDBOOK.md`](./AGENT-HANDBOOK.md) | Deep-dive handbook for AI agents working on this repo |
| [`docs/TIMELINE.md`](./docs/TIMELINE.md) | Chronological history of every session and fix |
| [`DESIGN.md`](./DESIGN.md) | EMBER design system — the UI laws (read before touching renderer UI) |
| [`REPORT-001..008`](./) | Per-fix QA reports with evidence |
| [`RELEASE_READINESS.md`](./RELEASE_READINESS.md) | Release gate assessment (2026-07-10 snapshot) |
| [`FREEBUFF-LOOK-HERE.md`](./FREEBUFF-LOOK-HERE.md) | Session handoff: auth sync + launch truthfulness |
| [`FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md`](./FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md) | Session handoff: home character animation director |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

TBD
