<h1 align="center">Hyakki</h1>

<p align="center">A control plane for coding agents, built for the Ryoku desktop.</p>

Hyakki runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from another device.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, Hyakki can control it.

## What you get

- **Your subscriptions.** Hyakki drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads.
- **Remote ready.** Run agents on any machine and connect over your local network or Tailscale.
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Open.** The source code is MIT licensed.

## Build from source

Hyakki has no published releases yet. Build it with the [development runbook](./docs/operations/00_development.md#first-checkout); the [architecture overview](./docs/internals/01_architecture.md) explains how it fits together.

Hyakki needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. [Provider setup](./docs/user/install.md#providers) has the steps for each agent.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report bugs and ideas in [issues](https://github.com/Ryoku-dev/hyakki/issues).

## Credits

Hyakki is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code), created by T3 Tools, Inc. and its contributors. Almost all of the code here is their work, used under the MIT License. Hyakki is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. "T3 Code" and the T3 marks belong to T3 Tools, Inc. See [NOTICE](./NOTICE).

## License

The source code is licensed under the [MIT License](./LICENSE).
