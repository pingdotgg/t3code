# FAQ

## Is Hyakki a harness?

No. A harness turns an LLM into an agent (tools, execution loop, and results)—like Claude Code's Agent SDK or Codex App Server. Hyakki drives those harnesses through one fast interface; it does not work without at least one installed agent.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, or any [ACP agent](./providers-acp.md). See [Provider setup](./install.md#providers). (Longer read: [What is a harness?](https://t3.gg/blog/post/what-is-a-harness))

## Why use Hyakki instead of Claude Code or the Codex app?

- **Bring your own subscription**: Use Claude, Codex, and every other agent you already have installed in one place.
- **Remote-first**: Run `hyakki up` on any box and drive it from anywhere.
- **Native mobile app**: Approve steps, review PRs, and steer threads from iOS and Android.
- **Open source (MIT)**: Fork the source code under your own branding if you ever want something different.

## Can I use Hyakki with my Claude Code subscription?

Yes.

## How much does Hyakki cost?

Nothing. You pay your own model and agent providers.

## Can I fork or redistribute Hyakki?

Yes. The source code is MIT licensed. Hyakki is itself an unofficial fork of T3 Code; see [NOTICE](../../NOTICE).

## Why is my Claude 5-hour limit draining so fast?

Since v0.1.7, Claude in Hyakki drains your 5-hour limit at the same rate as Claude Code directly (an earlier Anthropic Agent SDK discrepancy has been resolved). If you still see it, [update Hyakki](./updating.md) on the machine running your agents.

## How do I use Hyakki remotely?

Your agents run wherever the Hyakki server runs (desktop, server, or VPS). Run `hyakki up` on that machine and connect over your LAN, Tailscale, a VPN or SSH. See [Remote access](./remote-access.md).

## How do I use Hyakki on my phone?

There is no Hyakki phone app yet. Open the host's web address in your phone's browser over Tailscale or your LAN and pair with a link from **Settings → Sharing & access**. Your host computer runs the agents and must stay on. See [Remote access](./remote-access.md).

## Will I get banned for using my subscription?

No. Hyakki stays within the TOS of Claude Code, Codex, Google Antigravity, Grok Build, Cursor, and official ACP bindings.

## Can I add a bunch of accounts for one provider?

Hyakki intentionally does not include an automatic multi-account switcher to avoid risking provider TOS bans. Adding a separate work/personal account is supported ([Codex](./providers-codex.md#use-multiple-accounts), [Claude](./providers-claude.md#multiple-accounts-and-presets)). For larger pools managed externally (e.g. via [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)), Hyakki can display pooled limits under Usage ([Connect a hub](./usage.md#connect-a-cliproxyapi-hub)).

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in **Settings → Providers** with its own environment variables and endpoint (your subscription setup stays untouched). See [OpenRouter for Claude](./providers-claude.md#openrouter-and-local-routers) and [Providers](./install.md#providers).

## Does Hyakki support local models?

No. Hyakki focuses on frontier coding agents.

## Does my code go to Hyakki servers?

No. Code and prompts go directly from your machine to your chosen provider.

Hyakki also collects no usage data. See [Usage data](./telemetry.md).

## Worktrees are eating my disk. How do I clean them up?

Enable automatic cleanup or run **Delete now** in **Settings → Worktrees → Cleanup**. See [Storage cleanup](./project-settings.md#storage-cleanup).

## Is there voice input?

Yes—on-device speech on iOS, Android, and macOS 26+ desktop, or via a paired environment on web/desktop/mobile. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three (desktop app and CLI). Note: there is no standalone `hyakki` binary for Intel Macs (use the desktop app there), and Windows users can also run agents inside WSL. See [Install](./install.md).

## Why is my provider not showing up?

Usually the provider CLI is not installed, not signed in, or not on the `PATH` of the **server machine** (especially with version managers). Authenticate on the server machine first (e.g. `codex login` or `claude auth login`) and set **Binary path** in **Settings → Providers** if needed.
