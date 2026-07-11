# Contributing to MU Launcher

Thanks for your interest in contributing to the MU Launcher! 🎉

## How to Contribute

1. **Fork** the repository on GitHub.
2. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. **Make your changes** and commit them (see commit conventions below).
4. **Push** your branch and open a **Pull Request** against `main`.
5. A maintainer will review your PR. Address any feedback, and once approved it will be merged.

## Development Setup

```bash
git clone https://github.com/masters-union/mu-launcher
cd mu-launcher
npm install
npm run dev
```

### Prerequisites

- Node.js 20+
- Git
- Windows 10/11 (x64)

## Code Style

- **ESLint** — linting is enforced via `npm run lint`
- **Prettier** — code formatting is enforced via `npm run format` (run before committing)

Please ensure your code passes both linting and type checking:

```bash
npm run typecheck
npm run lint
```

## Commit Message Convention

We follow **Conventional Commits**:

- `feat:` — a new feature
- `fix:` — a bug fix
- `chore:` — maintenance tasks
- `docs:` — documentation changes
- `refactor:` — code restructuring without feature or fix

Examples:

```
feat: add auto mod sync endpoint
fix: resolve crash on profile switch
docs: update quick start instructions
```

## Pull Request Template

When opening a PR, please include:

- A clear description of the change
- Screenshots or recordings for UI changes
- Related issue numbers (if applicable)
- Steps to test the change
