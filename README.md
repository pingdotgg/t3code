<p align="center">
  <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="tix mammoth" />
</p>

<h1 align="center">tix</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="./docs/README.md">Docs</a> ·
  <a href="./docs/operations/00_development.md">Development</a> ·
  <a href="./TRADEMARK.md">Branding & Attribution</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

tix runs the coding agents on your machine and gives them one fast interface across desktop, web, and mobile.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, tix can control it.

## What you get

- **Your subscriptions.** tix does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Switch models or providers mid-thread and coordinate work across agents.
- **Desktop, web, and mobile.** One Node WebSocket server backs the web app, Electron desktop app, and React Native mobile client.
- **Remote ready.** Run agents on any machine and connect over your local network or Tailscale (see [remote access](./docs/user/remote-access.md)).
- **Git built in.** Each thread can work in its own worktree. Review diffs, commit, push, and open pull requests directly from the UI.
- **Open source.** Source code is licensed under the [MIT License](./LICENSE).

## Getting started from source

tix is currently built and run from source.

### Prerequisites

- [Vite+](https://viteplus.dev/guide/) (`vp` manages the pinned Node.js version from `package.json`):

```bash
curl -fsSL https://vite.plus | bash
# Windows PowerShell: irm https://vite.plus/ps1 | iex
```

- At least one supported coding agent installed and signed in (for example, [Claude Code](https://claude.com/product/claude-code) via `claude auth login` or [Codex CLI](https://developers.openai.com/codex/cli) via `codex login`). See [provider setup](./docs/user/install.md#providers) for all supported agents.

### Run locally

```bash
git clone https://github.com/penouc/tix.git
cd tix
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. Other dev entrypoints:

- `vp run dev:desktop` — Electron desktop app
- `vp run dev:server` — WebSocket server only
- `vp run dev:web` — Web client only
- See [apps/mobile/README.md](./apps/mobile/README.md) for the iOS / Android client and [docs/operations/00_development.md](./docs/operations/00_development.md) for full development details.

## Documentation

- [Development runbook](./docs/operations/00_development.md)
- [Architecture overview](./docs/internals/01_architecture.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)

[All docs](./docs/README.md) has the full list.

## License and upstream attribution

The source code in this repository is licensed under the [MIT License](./LICENSE).

The MIT license applies only to the source code and does not grant rights to T3 Tools, Inc.'s trademarks or branding. See [TRADEMARK.md](./TRADEMARK.md) for branding details and the upstream trademark policy.

**tix is an unofficial fork of T3 Code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc.**
