# T3 Agents

> [!IMPORTANT]
> **T3 Agents is an unofficial fork and UI wrapper around [T3 Code](https://github.com/pingdotgg/t3code),
> the original project by the T3 Tools team.**
>
> We do not maintain, own, or manage T3 Code. Everything underneath this interface — the server,
> orchestration, provider adapters, and provider CLIs — comes from the upstream project, and we only
> add UI on top of it. Because upstream keeps moving, things here can break, lag behind, or change
> without notice. For the supported, maintained product, use
> **[T3 Code](https://github.com/pingdotgg/t3code)**.

T3 Agents is a focused front end for the [T3 Code](https://github.com/pingdotgg/t3code) agent harness
control surface. It lets you direct the agents on your machine — Claude Code, Codex, Cursor, Grok
Build, OpenCode, Google Antigravity, and fx — from one workspace, with the same mobile app
([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), web app, and
[Electron-based desktop app](https://t3.codes) surfaces as upstream.

## "Wait, what are you selling me?"

Nothing. This fork exists because we wanted to build on top of T3 Code, not because we are selling
anything. T3 Code itself was built by its own team to be performant, remote-ready, and truly open; if
you want the project those words describe, use [the original](https://github.com/pingdotgg/t3code).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Desktop app

Download T3 Agents from this fork's [GitHub Releases](https://github.com/jayleaton/t3code/releases): the `.dmg` on macOS, the `.exe` on Windows, or the `.AppImage` or `.deb` on Linux. Its updater then follows this fork's nightly releases; there is no Stable track yet.

`winget`, Homebrew, the AUR, Nix, `t3.codes/install.sh` and `npx t3` all install upstream T3 Code, not T3 Agents.

### Command line

The desktop app includes the `t3` command (**Settings → About → t3 command**). `t3 update` and `t3 service install` download this fork's releases. For a Linux machine without a desktop, see [Headless Linux host](./docs/operations/headless-linux.md).

### Switching from T3 Code

T3 Agents uses the same data directory (`~/.t3`), so your projects, threads, settings, provider sign-ins and paired devices carry over, and phones and other machines still recognise this one. Your database is upgraded the first time T3 Agents starts.

- Quit T3 Code first. The two apps share one profile, so only one of them can run at a time.
- If you installed T3 Code's background service, run `t3 service uninstall` before opening T3 Agents. Otherwise that service keeps using your data directory and T3 Agents cannot start its own server.
- T3 Agents does not include T3 Connect. Devices you paired through T3 Connect need to pair again over your local network or tailnet ([remote access](./docs/user/remote-access.md)).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
