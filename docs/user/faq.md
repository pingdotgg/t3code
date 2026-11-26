# FAQ

## Is HYR Code a harness?

No. A harness turns an LLM into an agent (tools, execution loop, and results)—like Claude Code's Agent SDK or Codex App Server. HYR Code drives those harnesses through one fast interface; it does not work without at least one installed agent.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, or any [ACP agent](./providers-acp.md). See [Provider setup](./install.md#providers). (Longer read: [What is a harness?](https://t3.gg/blog/post/what-is-a-harness))

## Why use HYR Code instead of Claude Code or the Codex app?

- **Bring your own subscription**: Use Claude, Codex, and every other agent you already have installed in one place.
- **Remote-first**: Run `t3 up` on any box and drive it from anywhere.
- **Open source (MIT)**: Fork the source code under your own branding if you ever want something different.

## Can I use HYR Code with my Claude Code subscription?

Yes.

## How much does HYR Code cost?

Nothing. You pay your own model/agent providers.

## Can I fork or redistribute HYR Code?

Yes, for the source code. The [MIT License](../../LICENSE) applies only to the source code, not to names, logos, or branding. HYR Code itself is an unofficial fork based on the T3 Code source code, and is not affiliated with or endorsed by T3 Tools, Inc. If you publish a fork, use your own branding and make it clear that your project is unofficial. See [TRADEMARK.md](../../TRADEMARK.md).

## Why is my Claude 5-hour limit draining so fast?

Since v0.1.7, Claude in HYR Code drains your 5-hour limit at the same rate as Claude Code directly (an earlier Anthropic Agent SDK discrepancy has been resolved). If you still see it, [update HYR Code](./updating.md) on the machine running your agents.

## How do I use HYR Code remotely?

Your agents run wherever the HYR Code server runs (desktop, server, or VPS). Run `t3 up` on that machine, then connect over your local network or Tailscale. HYR Code release builds do not include T3 Connect. See [Remote access](./remote-access.md).

## How do I use HYR Code on my phone?

HYR Code has no app store release. Open the web app from your phone over your local network or Tailscale. The phone is a remote. Your computer does the work and needs to stay on. [Remote access](./remote-access.md)

## Will I get banned for using my subscription?

HYR Code uses the same provider integrations as upstream T3 Code. The T3 Code team states that these integrations are within the terms of service of Claude Code, Codex, and Google Antigravity, and that they built the Grok Build and Cursor integrations with SpaceXAI. Everything else uses official ACP bindings. Check your provider's terms if you are unsure.

## Can I add a bunch of accounts for one provider?

HYR Code intentionally does not include an automatic multi-account switcher to avoid risking provider TOS bans. Adding a separate work/personal account is supported ([Codex](./providers-codex.md#use-multiple-accounts), [Claude](./providers-claude.md#multiple-accounts-and-presets)). For larger pools managed externally (e.g. via [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)), HYR Code can display pooled limits under Usage ([Connect a hub](./usage.md#connect-a-cliproxyapi-hub)).

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in **Settings → Providers** with its own environment variables and endpoint (your subscription setup stays untouched). See [OpenRouter for Claude](./providers-claude.md#openrouter-and-local-routers) and [Providers](./install.md#providers).

## Does HYR Code support local models?

No. HYR Code focuses on frontier coding agents.

## Does my code go to T3 servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us or to T3. HYR Code release builds turn off product usage events, T3 Connect, and guest links. If you build from source without the release patch, the server sends basic product usage events (provider, model, token totals, no prompts or file contents) to T3 unless you set `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1`. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Enable automatic cleanup or run **Delete now** in **Settings → Worktrees → Cleanup**. See [Storage cleanup](./project-settings.md#storage-cleanup).

## Is there voice input?

Yes—on-device speech on iOS, Android, and macOS 26+ desktop, or via a paired environment on web/desktop/mobile. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

The source code runs on all three. HYR Code publishes a desktop build for macOS on Apple silicon only. On Windows, Linux, and Intel Macs, build HYR Code from source; the downloads and package managers for those platforms install upstream T3 Code. Windows users can also run agents inside WSL. See [Install](./install.md).

## Why is my provider not showing up?

Usually the provider CLI is not installed, not signed in, or not on the `PATH` of the **server machine** (especially with version managers). Authenticate on the server machine first (e.g. `codex login` or `claude auth login`) and set **Binary path** in **Settings → Providers** if needed.
