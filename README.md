<p align="center">
  <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="HYR Code logo" />
</p>

<h1 align="center">HYR Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://github.com/HYRMedia-LLC/t3code/releases"><strong>Releases</strong></a> ·
  <a href="./docs/README.md">Docs</a>
</p>

> HYR Code is an unofficial fork based on the [T3 Code](https://github.com/pingdotgg/t3code) source code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc.

HYR Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, HYR Code can control it.

## What you get

- **Your subscriptions.** HYR Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network or Tailscale. See [remote access](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** Source code is MIT licensed. If you don't like something, fork it under your own branding (see [Unofficial fork](#unofficial-fork)).

## Install

Download a build from [Releases](https://github.com/HYRMedia-LLC/t3code/releases), or build from source with the [development runbook](./docs/operations/00_development.md#first-checkout).

### Sign in to an agent

HYR Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install HYR Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built HYR Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork the source code and build the tool that you want, under your own name and branding.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Build from source with the [development runbook](./docs/operations/00_development.md#first-checkout). The [architecture overview](./docs/internals/01_architecture.md) explains how it works.

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Unofficial fork

HYR Code is an unofficial fork based on the [T3 Code](https://github.com/pingdotgg/t3code) source code. It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. "T3 Code", "T3 Connect", and the T3 logos are trademarks of T3 Tools, Inc. See [TRADEMARK.md](./TRADEMARK.md).
