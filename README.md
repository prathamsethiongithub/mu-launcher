# Master Launcher — Masters' Union SMP

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/masters-union/mu-master-launcher/build.yml?label=Build)
![GitHub License](https://img.shields.io/github/license/masters-union/mu-master-launcher)

**Custom Minecraft Launcher for the Masters' Union SMP. One-click join. Zero friction.**

---

## Features

- 🔐 **Microsoft Auth** — Seamless Microsoft account sign-in
- 🧩 **Vanilla+Fabric Profiles** — Switch between vanilla and modded profiles
- 📦 **Auto Mod Sync** — Always up-to-date mods, no manual downloads
- ⚙️ **Auto Config Sync** — Keybindings, settings, and preferences synced
- 📡 **Server Status** — Live server health and player count
- 🔄 **Self-Updating** — The launcher updates itself automatically
- 🩺 **Smart Doctor** — Auto-detect and fix common issues
- 🐛 **Crash Diagnostics** — Detailed crash reports with one-click sharing

---

## Quick Start

```bash
git clone https://github.com/masters-union/mu-master-launcher
cd mu-master-launcher
npm install
npm run dev
```

### Prerequisites

- **Node.js 20+**
- **Git**
- **Windows 10/11 (x64)** — the only supported platform
- **Java 17+** (required for running Minecraft)

---

## Build

```bash
# Dev server with hot reload (Vite + Electron)
npm run dev

# Production build (compile main, preload, and renderer)
npm run build

# Build + package installer (electron-builder)
npm run build:electron

# Preview production build
npm run preview

# Lint source
npm run lint

# Type-check without emitting
npm run typecheck
```

The packaged installer will be output to the `dist/` directory as an `.exe` file.

---

## Project Structure

```
mu-master-launcher/
├── src/
│   ├── main/          # Electron main process
│   ├── preload/       # Preload scripts
│   ├── renderer/      # React UI
│   ├── shared/        # Shared types
│   └── ...
├── .github/workflows/ # CI/CD
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── tailwind.config.js
└── electron-builder.yml
```

---

## Tech Stack

| Layer            | Technology                           |
| ---------------- | ------------------------------------ |
| Desktop Shell    | [Electron](https://www.electronjs.org/) |
| Frontend         | [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| Bundler          | [electron-vite](https://electron-vite.org/) |
| Styling          | [Tailwind CSS](https://tailwindcss.com/) |
| Packaging        | [electron-builder](https://www.electron.build/) |
| CI/CD            | GitHub Actions (Windows runners)     |

---

## Founder's Approved Configuration

| Setting               | Value                                    |
| --------------------- | ---------------------------------------- |
| Launcher Name         | Master Launcher                          |
| Repository            | mu-master-launcher                       |
| Server                | mastersunion.minekeep.gg:25565           |
| Minecraft Version     | 1.21.5                                   |
| Fabric Loader         | 0.19.3                                   |
| Java Version          | 25                                       |
| Launcher Directory    | %APPDATA%/MasterLauncher                 |
| Default RAM           | 4 GB                                     |
| Auth System           | MSMC (Microsoft)                         |
| Update Channel        | GitHub Releases                          |
| Mod Distribution      | GitHub Releases                          |
| Release Channel       | stable                                   |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details on how to get involved.

---

## License

TBD
