---
title: "T3 Code FAQ"
description: "Find T3 Code answers about cost, coding agents, supported operating systems, API keys, code privacy, mobile apps, and common first-run problems."
updated: 2026-11-04
sources:
  - label: "T3 Code FAQ"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md"
  - label: "Install and configure providers"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Welcome wizard"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md"
  - label: "Updating apps and servers"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
  - label: "Official mobile store links"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/lib/site.ts"
  - label: "Product usage data and telemetry controls"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md"
  - label: "Codex authentication choices"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md"
  - label: "Cursor SDK authentication"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md"
  - label: "MIT license"
    url: "https://github.com/pingdotgg/t3code/blob/main/LICENSE"
faq:
  - question: "Why is a provider missing in T3 Code?"
    answer: "Check Settings \u2192 Providers for the computer running the T3 Code server. For CLI-based providers, install and authenticate the CLI there and set Binary path if needed. Cursor uses SDK sign-in or CURSOR_API_KEY; Codex connected through ChatGPT and Antigravity can use managed runtimes."
  - question: "Can I have separate work and personal provider accounts?"
    answer: "T3 Code supports separate provider instances with their own configuration and environment variables. Use the provider-specific account guide to keep those instances distinct."
  - question: "Can I use T3 Code without importing old projects?"
    answer: "T3 Code lets you finish setup without importing projects or configuring agents. You need an installed, authenticated provider before starting an agent thread."
  - question: "Why is T3 Code asking me to update another computer?"
    answer: "A T3 Code client and server can run on different devices. Update the computer named in the compatibility notice, then reconnect."
---

T3 Code is free, MIT licensed, and available for macOS, Windows, Linux, iOS, and Android. You bring a coding agent's subscription or credentials, and your agents run on the computer hosting the T3 Code server. These answers cover the choices you need before installing or starting a thread.

## Is T3 Code free?

Yes. There is no paid T3 Code subscription required to use the app. You still pay your agent provider for the subscription or API usage you connect. T3 Code does not turn those plans into unlimited inference or combine their billing.

T3 Connect currently has a free limit of three computers running T3 Code. Phones and browsers connecting to them do not count. Linking a paid T3 Chat account can raise the machine limit, but that is optional. The FAQ says T3 Connect pricing may change if operating costs require it.

Read [What is T3 Code?](/learn/start/what-is-t3-code) for the product distinction and [remote access](/learn/remote/remote-access) for connection options. T3 Chat is a separate product, rather than a required T3 Code subscription.

## Which coding agents does T3 Code run?

The installation documentation lists Codex, Claude Code, Cursor, Grok Build, Kiro, OpenCode, Antigravity, Pi, Muse Code, and fx. Providers have different installation and authentication steps. The welcome wizard checks Claude Code and Codex, while other providers can be enabled in Settings.

Use the [coding agent guides](/learn/providers) to choose a provider. Start with [Claude Code](/learn/providers/claude-code), [Codex](/learn/providers/codex), [Cursor](/learn/providers/cursor), or [OpenCode](/learn/providers/opencode) if you already use one of them.

T3 Code is not a model or a harness. Your provider supplies the harness that gives a model tools and runs its actions. T3 Code controls those agents through its clients. See [the control plane explanation](/learn/concepts/control-plane-for-coding-agents) before choosing between an account, a model, and a runtime.

## Which operating systems does T3 Code support?

The desktop app runs on macOS, Windows, and Linux. The command-line installers provide standalone servers on supported architectures. Intel Macs have a desktop app but no standalone `t3` executable. Windows can also run agents and projects inside a selected WSL distro.

| Where you want to work                      | What to install                              |
| ------------------------------------------- | -------------------------------------------- |
| Local desktop                               | The desktop app for macOS, Windows, or Linux |
| Server controlled through a web client      | The CLI on the server's machine              |
| Phone or tablet controlling another machine | The iOS or Android app                       |

Get releases from [Download T3 Code](/download) and follow [official download verification](/learn/start/verify-official-download). The only official website is `t3.codes`. The page links the official release repository and mobile listings.

## Does T3 Code need my API key?

An API key is not required for every provider setup. T3 Code can use your existing provider subscription and authentication. The documentation supports Claude Code subscription use and Codex connected through ChatGPT or an authenticated Codex CLI.

API keys and custom endpoints are another supported configuration. Add a provider instance in Settings and give that instance its own environment variables. Mark secret values as sensitive so their original values are not displayed after saving.

Choose [Claude Code setup](/learn/providers/claude-code) or [Codex setup](/learn/providers/codex) for the authentication path you intend to use. Credentials belong to the environment running that provider. Signing in on a different client does not install or authenticate a CLI on the host.

## Does T3 Code send my code anywhere?

Your code and prompts go from your machine to the provider you select, such as Anthropic or OpenAI. They do not go to T3 Tools as coding-session content. This does not mean the code stays entirely offline: provider processing is part of using those agents.

T3 Code sends basic product usage events, including provider, model, and token totals. Those events exclude prompts and file contents. Set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before starting it to disable product events and relay tracing. Read [product usage data](/learn/safety/product-usage-data) for that control and its scope.

With T3 Connect, session traffic uses a Cloudflare tunnel on your machine. The T3 relay establishes the connection and does not proxy your HTTP or WebSocket sessions. Read [security and privacy](/learn/safety/security-and-privacy) for the data path rather than treating every remote connection as the same service.

## Is there a T3 Code mobile app?

Yes. T3 Code has [an App Store listing for iPhone and iPad](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) and [a Google Play listing for Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code). The mobile app is a remote client. Your connected computer performs the work and must remain on.

Use T3 Connect or a pairing link to connect it. You can also find store links and QR codes in `Settings → About → Mobile app`. Store apps work with Stable and Nightly servers; test builds are optional. Follow [mobile app setup](/learn/remote/mobile-apps) for the complete path.

## How do I start if I already have conversations?

The [welcome wizard](/learn/start/welcome-wizard) finds projects used by Claude Code, Codex, or Pi and can import recent conversations. Import keeps visible user and assistant messages within its limits. It omits tool activity and attachments, so review the retained history before continuing important work.

An older T3 Code installation has a separate migration path during an update. Follow [Update T3 Code](/learn/start/updating) before replacing an important existing installation. Client and server versions need compatible protocols, and the update notice names the side to change.

## Next steps

- Follow [Get started](/learn/start) and download through [the official download page](/download).
- Complete the [welcome wizard](/learn/start/welcome-wizard), then choose your [coding agent](/learn/providers).
- Review [product usage data](/learn/safety/product-usage-data) before deciding whether to disable telemetry.
