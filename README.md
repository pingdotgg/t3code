# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and OpenCode, more coming soon).

## Installation

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

## Fork Releases

If you want desktop releases and auto-updates from a fork or branch such as `main-xavier`, use the `Release Desktop` GitHub Actions workflow with:

- `target_branch`: the branch you want to release from, for example `main-xavier`
- `publish_cli`: `false` for fork/private desktop-only releases
- `finalize_version_bump`: `false` unless you want the workflow to push the version bump commit back to that branch

The packaged desktop app will target the current GitHub repository for updater assets during CI builds, so fork releases will update from that fork's GitHub Releases.

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
