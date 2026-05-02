# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

## Installation

## Local Development Toolchain

This repo expects the versions declared in `.mise.toml`:

- Node `24.13.1`
- Bun `1.3.9`

Recommended setup:

```bash
mise install
```

Then activate `mise` in your shell so entering the repo automatically uses the right versions. If you use `nvm`, there is also an `.nvmrc` with the same Node version.

Quick verification:

```bash
node -v
bun -v
```

Both should match the versions above before you run `bun run typecheck`, `bun run start:desktop:main-state`, or other repo scripts.

The root scripts now fail fast with a direct toolchain error if your shell is on the wrong Node version. As a fallback, you can also run commands through `mise` explicitly:

```bash
mise exec node@24.13.1 -- bun run typecheck
```

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
