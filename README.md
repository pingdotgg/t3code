# T3 Code

T3 Code is a minimal web GUI for coding agents made by [Pingdotgg](https://github.com/pingdotgg). This project is a downstream fork of [T3 Code](https://github.com/pingdotgg/t3code) customised to my utility and includes various PRs/feature additions from the upstream repo. Thanks to the team and its maintainers for keeping it OSS and an upstream to look up to.

It supports Codex, Claude Code, Cursor, Copilot, Gemini CLI, Amp, Kilo, and OpenCode.

(NOTE: Amp /mode free is not supported, as Amp Code doesn't support it in headless mode - since they need to show ads for that business model to work.)

## Why the fork?
This fork is designed to keep up a faster rate of development customised to my needs (and if you want, _yours_ as well -> Submit an issue and I'll make a PR for it). There's certain features which will (rightly) remain out of scope/priority for the project at its scale, but might be required for someone like me.

### Multi-provider support
Adds full provider adapters (server managers, service layers, runtime layers) for agents that are not yet on the upstream roadmap:

| Provider | What's included |
| --- | --- |
| Amp | Adapter + `ampServerManager` for headless Amp sessions |
| Copilot | Adapter + CLI binary resolution + text generation layer |
| Cursor | Adapter + ACP probe integration + usage tracking |
| Gemini CLI | Adapter + `geminiCliServerManager` with full test coverage |
| Kilo | Adapter + `kiloServerManager` + OpenCode-style server URL config |
| OpenCode | Adapter + `opencodeServerManager` with hostname/port/workspace config |
| Claude Code | Full adapter with permission mode, thinking token limits, and SDK typings |

### UX enhancements

| Feature | Description |
| --- | --- |
| Settings page | Dedicated route (`/settings`) for theme, accent color, and custom model slug configuration |
| Accent color system | Preset palette with contrast-safe terminal color injection across the entire UI |
| Theme support | Light / dark / system modes with transition suppression |
| Command palette | `Cmd+K` / `Ctrl+K` palette for quick actions, script running, and thread navigation |
| Sidebar search | Normalized thread title search with instant filtering |
| Plan sidebar | Dedicated panel for reviewing, downloading, or saving proposed agent plans |
| Terminal drawer | Theme-aware integrated terminal with accent color styling |

### Branding & build
- Custom abstract-mark app icon with macOS icon composer support
- Centralized branding constants for easy identity swaps
- Desktop icon asset generation pipeline from SVG source

### Developer tooling
- `sync-upstream-pr-tracks` script for tracking cherry-picked upstream PRs
- `cursor-acp-probe` for testing Cursor Agent Communication Protocol
- Custom alpha workflow playbook (`docs/custom-alpha-workflow.md`)
- Upstream PR tracking config (`config/upstream-pr-tracks.json`)

## Getting started

### Quick install (recommended)

Run the interactive installer — it detects your OS, checks prerequisites (git, Node.js ≥ 24, bun ≥ 1.3.9), installs missing tools, and lets you choose between development/production and desktop/web builds:

```bash
# macOS / Linux / WSL
bash <(curl -fsSL https://raw.githubusercontent.com/aaditagrawal/t3code/main/scripts/install.sh)
```

```powershell
# Windows (Git Bash, MSYS2, or WSL)
bash <(curl -fsSL https://raw.githubusercontent.com/aaditagrawal/t3code/main/scripts/install.sh)
```

The installer supports **npm, yarn, pnpm, bun, and deno** detection, and will auto-install bun if no suitable package manager is found. It provides OS-specific install instructions for any missing prerequisites (Homebrew on macOS, apt/dnf/pacman on Linux, winget on Windows).

### Manual build

 > [!WARNING]
 > You need at least one supported coding agent installed and authorized. See the supported agents list below.

 ```bash
 # Prerequisites: Bun >=1.3.9, Node >=24.13.1
 git clone https://github.com/aaditagrawal/t3code.git
 cd t3code
 bun install
 bun run dev
 ```

## Supported agents

 - [Codex CLI](https://github.com/openai/codex) (requires v0.37.0 or later)
 - [Claude Code](https://github.com/anthropics/claude-code) — **not yet working in the desktop app**
 - [Cursor](https://cursor.sh)
 - [Copilot](https://github.com/features/copilot)
 - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
 - [Amp](https://ampcode.com)
 - [Kilo](https://kilo.dev)
 - [OpenCode](https://opencode.ai)

## Notes

 - This project is very early in development. Expect bugs. (Especially with my fork)
 - Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md).
 - Maintaining a custom fork or alpha branch? See [docs/custom-alpha-workflow.md](docs/custom-alpha-workflow.md).
