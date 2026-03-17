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

## Shared history (web + desktop)

You can point T3 Code Desktop at the same server-backed history that the web UI is already using and keep one shared chat timeline between web and desktop.

Set desktop remote mode before launch:

```bash
export T3CODE_DESKTOP_REMOTE_URL="<the current web UI server endpoint>"
export T3CODE_DESKTOP_REMOTE_AUTH_TOKEN="<the auth token used by that server>"
```

Desktop will attach to that server as the source of truth (no silent fallback local history backend).
You can also configure the same shared-history mode from the desktop app Settings screen by copying the current server endpoint shown in the web UI.
See [REMOTE.md](./REMOTE.md) for full LAN/Tailscale setup.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
