# T3 Code + Pi

T3 Code is a minimal web GUI for coding agents. This branch adds Pi as a local
CLI/TUI-backed provider alongside Codex, Claude, Cursor, and OpenCode.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, OpenCode, and Pi.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Pi: install the Pi CLI and authenticate/configure it normally. T3 reads Pi's existing `~/.pi/agent` config.

## Pi Provider

Pi support in this branch is an executable integration, not a generic API key
provider. T3 discovers the local `pi` binary, reads the existing Pi configuration
under `~/.pi/agent`, and uses Pi RPC mode for model discovery, prompts, and
session execution.

Current Pi behavior:

- Pi appears as a selectable provider in T3.
- Model options are populated from live Pi RPC discovery.
- The configured/default Pi model is ordered first when available.
- Assistant text streams from Pi `text_delta` events when T3 assistant streaming is enabled.
- Pi reasoning and tool-call RPC events are filtered out of visible assistant text.
- Pi slash commands are exposed on a best-effort basis; exact TUI-only command parity is documented in [PI_PARITY.md](./PI_PARITY.md).

For local development against an existing Pi setup:

```bash
bun install
bun run dev
```

If your default T3 state has old local migrations, use an isolated test home:

```bash
T3CODE_HOME=/tmp/t3-pi-provider-verify T3CODE_DEV_INSTANCE=piverify bun run dev
```

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

Pi integration notes:

- Research and implementation plan: [RESEARCH.md](./RESEARCH.md), [PLAN.md](./PLAN.md)
- Edit/test loop log: [ATTEMPTS.md](./ATTEMPTS.md)
- Slash-command and model parity: [PI_PARITY.md](./PI_PARITY.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
