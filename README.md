# T3 Code

> [!IMPORTANT]
> This is a **Grok reliability fork** of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Upstream Grok Build in T3 hung, cancelled **Always allow**, hid plan cards, skipped usage and skills, and flooded the server with tool output. The rest of this README is upstream's. The list below is what this fork changes.

## What's fixed in this fork

### Turns settle instead of hanging

- **Stalled turns time out.** If Grok goes silent with no content or tool progress, the turn settles instead of spinning forever (10 minutes during reasoning, 30 minutes while a tool is active).
- **The liveness watchdog stays awake.** A pause could consume a wake signal and leave the watchdog blocked, so a later stall never settled.
- **Plan mode no longer hangs on exit.** Grok reverse-RPCs the client to approve `exit_plan_mode`. T3 never handled that, so the turn sat there waiting.

### Plan mode shows up as a plan card

- Session `plan.md` writes land in T3's proposed-plan card, which is how you approve or reject the plan. The native Grok gate is abandoned so the card can finish the flow.
- Only plans under `.grok/sessions` are promoted. A `plan.md` in the repo is just a file.
- An empty `exit_plan_mode` does not resurrect the previous turn's plan.
- Re-proposing the same plan text later still shows a new card.
- Plan path matching works on Windows, with `HOME` / `GROK_HOME` outside the default home, and rejects `..` path traversal.
- Empty `plan.md` writes (a clear) are accepted. Empty raw content no longer hides a following plan diff.

### Permissions follow the thread, not a hidden CLI flag

- **Always allow this session no longer cancels the turn.** Grok 4.6 often omits ACP `allow_always`. T3 still showed the button, then mapped the missing option to `cancelled`. It now falls back to `allow_once` and remembers the choice for the rest of the session. ([#6502](https://github.com/pingdotgg/t3code/issues/6502))
- **Supervised actually asks.** If `~/.grok` has `[ui] permission_mode = always-approve`, Supervised threads used to never prompt. They now start with `--permission-mode default` so the T3 thread mode wins. Full access still passes `--always-approve`.

### Tool output no longer freezes every other thread

- Grok's ACP CLI resends the _entire_ accumulated terminal output on every `tool_call_update` (~10/sec, 145 KB+ each). That flooded event ingestion and head-of-line-blocked other threads. Output is now capped to an 8 KB tail; diffs and images are left alone.
- Whitespace-only (or whitespace-padded) content used to skip that cap. It is bounded too.
- When a large tail is split across entries, content around images and diffs keeps its original order.
- Pending → in-progress tool status still emits even when detail and output are unchanged, so the UI does not look stuck.
- Live command output keeps flowing when the command itself is unchanged but stdout grows.

### Composer, usage, and errors

- **Skills** from `grok inspect --json` appear in the composer `$` picker (user, project, bundled, and plugin skills).
- **Reasoning levels** advertised by the installed Grok CLI appear next to the model picker.
- **Usage limit errors** show as "Grok usage limit reached. Try again later." instead of failing silently.
- **Usage page** includes Grok Build next to Claude and Codex (from `~/.grok/sessions/**/updates.jsonl`).

---

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
