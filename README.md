<h1 align="center">EasyDev Code</h1>

<p align="center">The open-source control plane for coding agents, from <a href="https://easydevsolucoes.com.br">EasyDev Soluções Digitais</a>.</p>

<p align="center">
  <a href="https://github.com/diogocoutinho/t3code/releases"><strong>Download</strong></a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="mailto:contato@easydevsolucoes.com.br">Contact</a>
</p>

<p align="center">
  <img src="./.github/readme/hero.webp" width="100%" alt="The app on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
</p>

EasyDev Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, EasyDev Code can control it.

Based on [T3 Code](https://github.com/pingdotgg/t3code) (MIT). EasyDev Code is an independent fork; it is not made or supported by T3 Tools.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

Download EasyDev Code for macOS or Linux from [Releases](https://github.com/diogocoutinho/t3code/releases).

### Command line

This installs the `t3` command from this fork's releases. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://raw.githubusercontent.com/diogocoutinho/t3code/main/scripts/install.sh \
  | T3CODE_RELEASE_REPOSITORY=diogocoutinho/t3code sh
```

### Phone

Store apps are not published yet. [Remote access](./docs/user/remote-access.md) explains how a phone connects to your computer.

### Sign in to an agent

EasyDev Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

- Report bugs and request features in [Issues](https://github.com/diogocoutinho/t3code/issues).
- Report vulnerabilities as [SECURITY.md](./SECURITY.md) describes.
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Changes that are not specific to this fork belong upstream in [T3 Code](https://github.com/pingdotgg/t3code); read its [CONTRIBUTING.md](./CONTRIBUTING.md) first.

## License

[MIT](./LICENSE)
