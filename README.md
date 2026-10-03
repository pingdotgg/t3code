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

## Some notes

Use the command palette's Search button to find projects and threads, including by full or
partial thread ID. Press Tab on a project result to add a scope chip, then keep typing to
search only that project's threads and conversations. Tab on a thread result narrows to
that thread and its subthreads. Backspace in an empty search or the chip's remove button
removes a scope. You can also commit `project:name` or `thread:title` with space or Tab;
quote names containing spaces. Multiple projects are combined, while project and thread
scopes intersect. Search excludes archived threads by default. Select "Search archived
threads", or type `archived` and press Tab or Space, to add an Archived chip and search
only archived threads (including IDs and conversation content). Combine it with project
or thread chips to narrow the archive; removing the Archived chip returns to active threads.

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
pnpm install
```

Linux desktop builds also require a C compiler, `pkg-config`, and libsecret development
headers (`sudo apt-get install build-essential pkg-config libsecret-1-dev` on Debian/Ubuntu).
The desktop build compiles and packages the cookie-import helper; Linux release artifacts
must be built on a Linux host for the target architecture.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
