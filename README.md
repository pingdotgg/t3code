<!-- Banner Image -->

<p align="center">
  <a href="https://github.com/munimtechnologies/mtcode">
    <img alt="Munim Technologies" height="128" src="./.github/resources/banner.png">
    <h1 align="center">MT Code</h1>
  </a>
</p>

<p align="center">
  <a aria-label="Latest release" href="https://github.com/munimtechnologies/mtcode/releases/latest" target="_blank">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/munimtechnologies/mtcode?filter=munim-v*&style=flat-square&label=Version&labelColor=000000&color=0066CC" />
  </a>
  <a aria-label="App is free to use" href="https://github.com/munimtechnologies/mtcode/blob/main/LICENSE" target="_blank">
    <img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache%202.0-success.svg?style=flat-square&color=33CC12" />
  </a>
  <a aria-label="daily active users" href="https://github.com/munimtechnologies/mtcode/blob/main/.github/workflows/download-counts.yml" target="_blank">
    <img alt="Daily Active Users" src="https://img.shields.io/endpoint?style=flat-square&url=https%3A%2F%2Fraw.githubusercontent.com%2Fmunimtechnologies%2Fmtcode%2Fmain%2F.github%2Fdownload-counts%2Factive-installs.json" />
  </a>
  <a aria-label="monthly downloads" href="https://github.com/munimtechnologies/mtcode/releases" target="_blank">
    <img alt="Monthly Downloads" src="https://img.shields.io/endpoint?style=flat-square&url=https%3A%2F%2Fraw.githubusercontent.com%2Fmunimtechnologies%2Fmtcode%2Fmain%2F.github%2Fdownload-counts%2Fdownloads-monthly.json" />
  </a>
  <a aria-label="total downloads" href="https://github.com/munimtechnologies/mtcode/releases" target="_blank">
    <img alt="Total Downloads" src="https://img.shields.io/endpoint?style=flat-square&url=https%3A%2F%2Fraw.githubusercontent.com%2Fmunimtechnologies%2Fmtcode%2Fmain%2F.github%2Fdownload-counts%2Fdownloads-total.json" />
  </a>
</p>

<p align="center">
  <a aria-label="download" href="https://munimtech.com/mtcode"><b>Download MT Code</b></a>
&ensp;•&ensp;
  <a aria-label="documentation" href="https://github.com/munimtechnologies/mtcode/tree/main/docs">Read the Documentation</a>
&ensp;•&ensp;
  <a aria-label="report issues" href="https://github.com/munimtechnologies/mtcode/issues">Report Issues</a>
</p>

<h6 align="center">Follow Munim Technologies</h6>
<p align="center">
  <a aria-label="Follow Munim Technologies on GitHub" href="https://github.com/munimtechnologies" target="_blank">
    <img alt="Munim Technologies on GitHub" src="https://img.shields.io/badge/GitHub-222222?style=for-the-badge&logo=github&logoColor=white" />
  </a>&nbsp;
  <a aria-label="Follow Munim Technologies on LinkedIn" href="https://linkedin.com/in/sheehanmunim" target="_blank">
    <img alt="Munim Technologies on LinkedIn" src="https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" />
  </a>&nbsp;
  <a aria-label="Visit Munim Technologies Website" href="https://munimtech.com" target="_blank">
    <img alt="Munim Technologies Website" src="https://img.shields.io/badge/Website-0066CC?style=for-the-badge&logo=globe&logoColor=white" />
  </a>
</p>

## Introduction

MT Code is a free, open-source desktop app for running and controlling coding agents — Claude Code, Codex, Cursor, Grok Build, OpenCode, Kiro, Pi, Muse Code, Vercel fx, and Google Antigravity — from one place. It is [Munim Technologies](https://munimtech.com)' fork of [T3 Code](https://github.com/pingdotgg/t3code) with extra features and fixes, and anyone can download and use it.

## Download

**[munimtech.com/mtcode](https://munimtech.com/mtcode)** — or grab installers straight from [GitHub Releases](https://github.com/munimtechnologies/mtcode/releases):

- **macOS** (Apple Silicon): `MT-Code-<version>-arm64.dmg`
- **Windows** (x64): `MT-Code-<version>-x64.exe`
- **Linux** (x64): `MT-Code-<version>-x86_64.AppImage`, or `MT-Code-<version>-amd64.deb` for Debian and Ubuntu

macOS builds are signed with a Developer ID and notarized by Apple, so they open without a Gatekeeper warning. Windows builds are unsigned: if SmartScreen warns, choose **More info → Run anyway**.

On Linux, install the `.deb` with `sudo apt install ./MT-Code-*-amd64.deb`, or make the AppImage executable (`chmod +x`) and run it.

The app auto-updates from this repository, so you get new MT Code features and fixes as they ship.

### Use it from a browser or phone

MT Code has no hosted web app of its own. Run the desktop app (or `npx t3@latest`) on your machine and reach it from another device over T3 Connect or your own HTTPS tunnel (Tailscale Serve works well); see [remote access](./docs/user/remote-access.md).

## Before you start

MT Code drives agents you already have. Install and sign in to at least one provider CLI:

- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude`
- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Kiro: install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login` ([setup](./docs/user/providers-kiro.md))
- Pi: install [Pi](https://pi.dev), run `pi` and `/login`, then enable it in Settings → Providers ([setup](./docs/user/providers-pi.md))
- Muse Code: install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`, then enable it in Settings → Providers ([setup](./docs/user/providers-muse.md))
- fx: install [fx](https://fx.sh) and run `fx login`, then enable it in Settings → Providers ([setup](./docs/user/providers-fx.md))
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

Your existing subscriptions are used directly — MT Code sells nothing and adds no accounts of its own.

Same cost model as T3 Code: the app and its server run on your computer, and model tokens come from Claude / Codex / Cursor / Grok / OpenCode / Kiro / Pi / Muse Code / fx / Antigravity. Munim hosts nothing on your behalf — pairing and Computer Use reach your machine directly. There is no Munim-hosted web app, no model proxy, no Workers AI classifier, and no PlanetScale relay unless you explicitly opt into that paid stack.

## MT Code vs T3 Code

Compared to [T3 Code](https://github.com/pingdotgg/t3code). MT Code started as a fork. Upstream is merged only when you ask an agent to do it — nothing pulls `pingdotgg/t3code` automatically. Some rows started as unmerged upstream PRs that MT Code ships today; others were built here.

This table lists only the differences, roughly in the order of how much they change the app. When T3 Code ships something MT Code had first, MT Code adopts T3 Code's version and drops the row. Recent examples: voice dictation on web and desktop, scripting threads with `t3 thread`, LaTeX math, thread find, Mermaid diagrams, effort keybindings, OpenCode context usage, model ordering, Codex multi-account sign-in, thread-to-thread messaging, scheduled sends, provider handoff, resume on restart and keeping threads with a PR out of auto-settle. Apart from the rows T3 Code wins at the bottom, nothing T3 Code ships is missing here.

| Feature                                                                                                                                                                                                                                                                                       | MT Code |                                                                            T3 Code                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-----: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------: |
| **Computer Use** — agents click, type, screenshot, zoom, hover, and drive tabs in your installed browsers on your desktop via open-source [munim-computer-use](https://github.com/munimtechnologies/munim-computer-use) (T3 Code's device tools reach only simulators)                        |   ✅    |                                                                              ❌                                                                               |
| **Chrome extension sets itself up** — on first launch MT Code adds its browser extension to your Chrome by clicking through chrome://extensions itself (Developer mode, Load unpacked); T3 Code has no browser extension                                                                      |   ✅    |                                                                              ❌                                                                               |
| **Computer View** — a live remote desktop of the machine a thread runs on, from the chat header; moving over it moves that machine's real cursor, and typing goes where it is focused                                                                                                         |   ✅    |                                                                              ❌                                                                               |
| **Agent-chosen computers** — `computer_list` / `computer_send` start a task on any machine the app already reaches (this Mac, SSH, T3 Connect, a paired backend) without changing **Run on** (T3 Code's Linked environments beta needs each machine linked first, for 30 days)                |   ✅    |                                                                              ❌                                                                               |
| **Realtime voice** — a call panel where you speak to the selected agent and it answers out loud; runs through your ChatGPT account (GPT-Live via Codex) or an OpenAI API key (T3 Code's voice input only dictates into a draft)                                                               |   ✅    |                                                                              ❌                                                                               |
| **Local sky artwork** — the sidebar header paints your own daylight and weather, and the app icon follows it; both ship on by default                                                                                                                                                         |   ✅    |                                                                              ❌                                                                               |
| **Monitor toolkit** — `monitor_start` lets Codex end its turn and be woken by each line a background command prints (T3 Code wakes Codex only when a background command exits; Claude Code and Grok bring their own monitors)                                                                 |   ✅    |                                                                              ❌                                                                               |
| **Plugin marketplace** — ChatGPT-style Plugins / Apps / MCPs / Skills tabs across Codex, Claude Code, and Cursor, with one-click install and a harness filter                                                                                                                                 |   ✅    |                                                                              ❌                                                                               |
| **Edit your last message in place** — rewrite the latest prompt where it sits; the thread rolls back and resends (T3 Code's _Edit from here_ moves it back to the composer)                                                                                                                   |   ✅    |                                                                              ❌                                                                               |
| **Codex's own visualizations** rendered inline (T3 Code renders only its own `html_render` pages and MCP Apps from Codex and Claude tool calls)                                                                                                                                               |   ✅    |                                                                              ❌                                                                               |
| **Find in the terminal** (Cmd/Ctrl+F)                                                                                                                                                                                                                                                         |   ✅    |                                                                              ❌                                                                               |
| **Skills manager** — cross-harness skills in Settings                                                                                                                                                                                                                                         |   ✅    |                                                                              ❌                                                                               |
| **Advisor model** — let Claude consult a second model (fable, opus, or sonnet) during a turn, set per Claude instance in Settings → Providers (T3 Code's `@opus`-style mentions only name a model in the prompt for the agent to delegate to)                                                 |   ✅    |                                                                              ❌                                                                               |
| **Multi-machine projects** — one-time copy of a project to another machine with uncommitted work, Git history, and folders without Git; `.worktreeinclude`; SSH agent forwarding (T3 Code's _Add to another machine_ only makes a fresh clone and copies chosen ignored files such as `.env`) |   ✅    |                                                                              ❌                                                                               |
| **Sign in extra Claude accounts** from Settings without leaving the app (T3 Code signs in Codex, Cursor, and Antigravity in-app, but not Claude)                                                                                                                                              |   ✅    |                                                                              ❌                                                                               |
| **Self-hosted Android push** for thread updates — sent from your own server, not T3 Code's hosted relay                                                                                                                                                                                       |   ✅    |                                                                              ❌                                                                               |
| **Upstream tracking for forks** — the Pull Requests page shows the upstream's latest release and its open pull requests ranked, with one-click take or port into a worktree                                                                                                                   |   ✅    |                                                                              ❌                                                                               |
| **Computer History** — opt-in activity timeline (not screenshots) that agents can reference                                                                                                                                                                                                   |   ✅    |                                                                              ❌                                                                               |
| **MT Code theme** — the shipped palette is its own theme (light plus a charcoal-and-blue dark), with T3 Code's stock pair one click away in the library                                                                                                                                       |   ✅    |                                                                              ❌                                                                               |
| **Recent-threads switcher** — Ctrl+Tab in the desktop app (browsers reserve Ctrl+Tab; rebind in Settings → Keybindings)                                                                                                                                                                       |   ✅    |                                                                              ❌                                                                               |
| **New thread on a computer** — the command palette's new-thread list has a Computers group that starts a thread on any connected machine with no project folder (T3 Code's lists only projects)                                                                                               |   ✅    |                                                                              ❌                                                                               |
| **OpenCode connected subscription limits** — saved ChatGPT and Claude account windows alongside upstream’s OpenCode Go limits                                                                                                                                                                 |   ✅    |                                                                              ❌                                                                               |
| **Rename environments**                                                                                                                                                                                                                                                                       |   ✅    |                                                                              ❌                                                                               |
| **Draft pull requests by default** — a switch in Settings → Source Control opens new GitHub pull requests as drafts                                                                                                                                                                           |   ✅    |                                                                              ❌                                                                               |
| **Per-provider permission defaults** — each provider instance can start new threads in its own permission mode, set in Settings → Providers (T3 Code has one default, overridable per project)                                                                                                |   ✅    |                                                                              ❌                                                                               |
| **`t3 .` opens a folder** — launches the desktop app if needed, or opens the folder on a running server (T3 Code's `t3 app` needs the desktop app already open)                                                                                                                               |   ✅    |                                                                              ❌                                                                               |
| **Desktop extras** — external terminal apps, login-shell env allowlist, Windows tray with persist-on-close                                                                                                                                                                                    |   ✅    |                                                                              ❌                                                                               |
| **Math rendering on by default** — LaTeX in replies typesets out of the box (T3 Code ships the same renderer switched off in Settings → Appearance)                                                                                                                                           |   ✅    |                                                                              ❌                                                                               |
| **Installs alongside T3 Code** — own bundle ID (`com.munim.mtcode`) and data directory (`~/.mt`)                                                                                                                                                                                              |   ✅    |                                                                              ❌                                                                               |
| **Mobile app** — MT Code has no app of its own; T3 Code's app pairs with an MT Code desktop and works with it                                                                                                                                                                                 |   ❌    | ✅ [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) · [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) |
| **Hosted web app** — MT Code's own was retired; use T3 Connect or your own tunnel instead                                                                                                                                                                                                     |   ❌    |                                                            ✅ [app.t3.codes](https://app.t3.codes)                                                            |

Everything else T3 Code does — multi-provider agent control, checkpoints and diffs, file previews (office, PDF, fonts, Mermaid, archives, SQLite), remote access from T3 Code's [web](https://app.t3.codes) and mobile apps, Connect tunnels, linked environments (Labs beta) — works here too.

## Documentation

Full docs live in [docs/](./docs):

- [FAQ](./docs/user/faq.md) (T3 Code's; where MT Code differs, the table above wins)
- [Install and first run](#download) (the inherited [`t3` CLI install guide](./docs/user/install.md) installs upstream T3 Code, not MT Code)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Desktop notifications](./docs/user/desktop-notifications.md)
- [Plugins](./docs/user/plugins.md)
- [Voice input](./docs/user/voice-input.md)
- [Attachments](./docs/user/attachments.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Thread messaging](./docs/user/thread-messaging.md)
- [Continue a thread with another provider](./docs/user/provider-handoff.md)
- [Sending work to another computer](./docs/user/computer-routing.md)
- [Viewing a thread's computer](./docs/user/computer-view.md)
- [Appearance: themes and sidebar artwork](./docs/user/appearance.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Relationship to upstream

MT Code does not auto-merge [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Upstream lands only when you explicitly ask an agent to merge it. Features built here are offered upstream as PRs when they fit; some MT Code features started as unmerged upstream PRs we adopted. Bug reports about MT Code builds belong on [this repo's issues](https://github.com/munimtechnologies/mtcode/issues) — please don't file MT Code problems upstream.

MT Code exists because T3 Code is truly open. Credit and thanks to the T3 team.
