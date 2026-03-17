# T3 Code

T3 Code is a minimal web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for T3 Code to work.

```bash
npx t3
```

You can also just install the desktop app. It's cooler.

Install the [desktop app from the Releases page](https://github.com/pingdotgg/t3code/releases)

## Shared remote history (phone + desktop)

You can run a single self-hosted `apps/server` instance and have both mobile web and desktop share the same chat history.

Set desktop remote mode before launch:

```bash
export T3CODE_DESKTOP_REMOTE_URL="https://your-server.example.com"
export T3CODE_DESKTOP_REMOTE_AUTH_TOKEN="your-auth-token"
```

Desktop will attach to that server as the source of truth (no silent fallback local history backend).
You can also configure the same remote/shared-history mode from the desktop app Settings screen.
See [REMOTE.md](./REMOTE.md) for full LAN/Tailscale setup.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
