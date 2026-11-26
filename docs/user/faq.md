# FAQ

## Is Hyakki a harness?

No. A harness turns an LLM into an agent (tools, execution loop, and results)—like Claude Code's Agent SDK or Codex App Server. Hyakki drives those harnesses through one fast interface; it does not work without at least one installed agent.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, or any [ACP agent](./providers-acp.md). See [Provider setup](./install.md#providers). (Longer read: [What is a harness?](https://t3.gg/blog/post/what-is-a-harness))

## Why use Hyakki instead of Claude Code or the Codex app?

- **Bring your own subscription**: Use Claude, Codex, and every other agent you already have installed in one place.
- **Remote-first**: Run `t3 up` on any box and drive it from anywhere.
- **Native mobile app**: Approve steps, review PRs, and steer threads from iOS and Android.
- **Open source (MIT)**: Fork the source code under your own branding if you ever want something different.

## Can I use Hyakki with my Claude Code subscription?

Yes.

## How much does Hyakki cost?

Nothing. You pay your own model/agent providers. Hyakki Connect is free for up to 3 connected host machines per account (phones and browsers don't count). You can also self-host or use LAN/Tailscale.

## Can I fork or redistribute Hyakki?

Yes. The source code is MIT licensed. Hyakki is itself an unofficial fork of T3 Code; see [NOTICE](../../NOTICE).

## Can I connect more than 3 machines with Hyakki Connect?

Yes. Link a paid T3 Chat account from your account menu → **T3 Chat → Link T3 Chat**: T3 Chat Pro raises the limit to 10 machines, and Premier raises it to 100. See [More machines with T3 Chat](./remote-access.md#more-machines-with-t3-chat).

## Why is my Claude 5-hour limit draining so fast?

Since v0.1.7, Claude in Hyakki drains your 5-hour limit at the same rate as Claude Code directly (an earlier Anthropic Agent SDK discrepancy has been resolved). If you still see it, [update Hyakki](./updating.md) on the machine running your agents.

## How do I use Hyakki remotely?

Your agents run wherever the Hyakki server runs (desktop, server, or VPS). Run `t3 up` on that machine and connect via Hyakki Connect, LAN, Tailscale, or [hyakki.ryoku.dev](https://hyakki.ryoku.dev). See [Remote access](./remote-access.md).

## How do I use Hyakki on my phone?

Install the [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Android](https://play.google.com/store/apps/details?id=dev.ryoku.hyakki) app and connect it to your computer with Hyakki Connect or a pairing link. The phone is a remote control—your host computer runs the agents and must stay on. See [Mobile app](./install.md#mobile-app) and [Remote access](./remote-access.md).

## Why does Hyakki Connect keep disconnecting?

Open **Settings → Environments**, select the machine, and choose **Details**—the first failed check identifies the cause. See [Hyakki Connect troubleshooting](./t3-connect-troubleshooting.md). Tailscale also works great as a direct fallback.

## Will I get banned for using my subscription?

No. Hyakki stays within the TOS of Claude Code, Codex, Google Antigravity, Grok Build, Cursor, and official ACP bindings.

## Can I add a bunch of accounts for one provider?

Hyakki intentionally does not include an automatic multi-account switcher to avoid risking provider TOS bans. Adding a separate work/personal account is supported ([Codex](./providers-codex.md#use-multiple-accounts), [Claude](./providers-claude.md#multiple-accounts-and-presets)). For larger pools managed externally (e.g. via [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)), Hyakki can display pooled limits under Usage ([Connect a hub](./usage.md#connect-a-cliproxyapi-hub)).

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in **Settings → Providers** with its own environment variables and endpoint (your subscription setup stays untouched). See [OpenRouter for Claude](./providers-claude.md#openrouter-and-local-routers) and [Providers](./install.md#providers).

## Does Hyakki support local models?

No. Hyakki focuses on frontier coding agents.

## Does my code go to Hyakki servers?

No. Code and prompts go directly from your machine to your chosen provider. With Hyakki Connect, traffic travels over a Cloudflare tunnel (`cloudflared` on your machine); Hyakki's relay coordinates the link without proxying your HTTP/WebSocket sessions.

Hyakki also collects no usage data. See [Usage data](./telemetry.md).

## Worktrees are eating my disk. How do I clean them up?

Enable automatic cleanup or run **Delete now** in **Settings → Worktrees → Cleanup**. See [Storage cleanup](./project-settings.md#storage-cleanup).

## Is there voice input?

Yes—on-device speech on iOS, Android, and macOS 26+ desktop, or via a paired environment on web/desktop/mobile. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three (desktop app and CLI). Note: there is no standalone `t3` binary for Intel Macs (use the desktop app there), and Windows users can also run agents inside WSL. See [Install](./install.md).

## Why is my provider not showing up?

Usually the provider CLI is not installed, not signed in, or not on the `PATH` of the **server machine** (especially with version managers). Authenticate on the server machine first (e.g. `codex login` or `claude auth login`) and set **Binary path** in **Settings → Providers** if needed.
