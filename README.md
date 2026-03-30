# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex and Claude.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the desktop app using whichever method fits your platform:

#### Direct download

[GitHub Releases](https://github.com/pingdotgg/t3code/releases)

#### Windows (`winget`)

Reference: [pingdotgg/t3code#1544](https://github.com/pingdotgg/t3code/issues/1544), [winget-pkgs manifest](https://github.com/microsoft/winget-pkgs/tree/master/manifests/t/T3Tools/T3Code/)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

Reference: [t3-code cask](https://formulae.brew.sh/cask/t3-code#default)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Reference: [t3code-bin](https://aur.archlinux.org/packages/t3code-bin)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
