# Contributing to Ember

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/prathamsethiongithub/mu-launcher
cd mu-launcher
npm install
npm run dev
```

### Prerequisites

- Node.js 20+
- Git
- Windows 10/11 (x64) — the only supported platform

## Code Style

- **ESLint** — `npm run lint`
- **Prettier** — installed as a dev dependency; format before committing
- **TypeScript** — strict; `npm run typecheck` must pass

Both gates must pass before any change is done:

```bash
npm run typecheck   # 0 errors
npm run build       # clean
```

(The production build uses esbuild, which does NOT catch everything `tsc` does — never assume a green build means a green typecheck.)

## Branches

The working branch is **`master`** (there is no `main`). Branch from it, PR back into it.

> Note: `.github/workflows/build.yml` currently triggers on `main` and has therefore never run — see `PROJECT_STATE.md` release-ops section if you're fixing CI.

## Commit Message Convention

**Conventional Commits**:

- `feat:` — a new feature
- `fix:` — a bug fix
- `chore:` — maintenance tasks
- `docs:` — documentation changes
- `refactor:` — code restructuring without feature or fix

Examples:

```
fix: read MCLC progress count from e.task
feat: add animation director for home character
docs: merge debug diaries into archive digest
```

## Pull Requests

When opening a PR, please include:

- A clear description of the change
- Screenshots or recordings for UI changes
- Steps to test the change
- Proof: typecheck/build output, and runtime evidence for behavioral fixes

## Scope guidance

This project is in **stabilization**. Read `PROJECT_STATE.md` first: known open issues are triaged there, and working systems should not be refactored without a proven defect. When in doubt, ask the owner before large structural changes.
