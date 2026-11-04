# T3 Learn

T3 Learn is a fork of [T3 Code](https://github.com/pingdotgg/t3code) for learning with AI.

When a reply uses something you don't know yet, highlight it and choose **Ask in side chat** (⌥⌘S on a Mac, Ctrl+Alt+S elsewhere). A side chat opens next to the lesson. It sees your highlight and a short summary of the lesson, and nothing you say in it lands in the lesson. Side chats nest, so you can follow a question as deep as it goes. The side-chat header's map toggle (⌥⌘G on a Mac, Ctrl+Alt+G elsewhere) shows where you are without leaving the chat. Press **Done** to climb back out: the AI writes a short note, and your next lesson message carries it so the lesson picks up where you left off. The first time you open T3 Learn, a short guide walks you through this; open it again from Settings.

See [Side chats](docs/user/side-chats.md) for settings and provider details.

### Install

**macOS and Linux**

```bash
curl -fsSL https://github.com/aabdel0181/t3-learn/releases/latest/download/install.sh | sh
```

**Windows** (in PowerShell)

```powershell
irm https://github.com/aabdel0181/t3-learn/releases/latest/download/install.ps1 | iex
```

T3 Learn opens when the installer finishes. After that, open it like any other app; it updates itself. You also need at least one provider set up, such as Claude Code or Codex (see [Installation](#installation)).

**Already using T3 Code?** Run the same command. T3 Learn installs next to T3 Code instead of over it, and keeps its own projects and settings in `~/.t3-learn`. T3 Code keeps its threads, settings, updates and `t3` command, and both apps can run at once. Providers you're already signed in to work in both.

<details>
<summary>Other ways to install, and how to remove it</summary>

- **Download it yourself** from [Releases](https://github.com/aabdel0181/t3-learn/releases/latest): `.dmg` for macOS, `.exe` for Windows, `.deb` or `.AppImage` for Linux. These builds are not signed. macOS blocks the app the first time you open it: go to **System Settings → Privacy & Security** and choose **Open Anyway**. Windows may warn that it doesn't recognize the app: choose **More info → Run anyway**. The install command avoids both prompts.
- **macOS updates:** because the app isn't signed, macOS may ask once after an update to let T3 Learn use its saved keychain item. Choose **Always Allow**. Screen Recording permission, used for window capture, has to be turned on again.
- **Linux:** the command installs the `.deb` where `apt` and `sudo` are available, so the app keeps Chromium's sandbox, and an AppImage in your home folder otherwise. Set `T3LEARN_FORMAT=appimage` or `T3LEARN_FORMAT=deb` to choose.
- **A specific version:** set `T3LEARN_VERSION`, for example `T3LEARN_VERSION=0.1.3-learn.1`.
- **Remove it:** on macOS and Linux, run the install command with `sh -s -- --uninstall` in place of `sh`. On Windows, uninstall **T3 Learn** from **Settings → Apps**. Your projects and settings stay in `~/.t3-learn`; delete that folder to remove them too.
- **From source:** you need [`vp`](#install-vp). Run `vp i`, then `vp run --filter t3 build`, then `vp env exec -- node apps/server/dist/bin.mjs serve --base-dir ~/.t3-learn`, and open the pairing URL it prints.

</details>

### Updating

New T3 Learn versions are released automatically from `main` after CI and the install tests pass. The app shows an update button that updates the app and its connected server together. On the server box, update the launcher with `t3-learn update --yes`; with the plain CLI, point `T3CODE_HOME` at `~/.t3-learn` first.

The phone app pairs with T3 Learn the same way it pairs with T3 Code. T3 Connect isn't available in T3 Learn's builds. To use T3 Learn's command line, choose **Install** next to **t3-learn command** in **Settings → About**.

**Want an agent to set it up, with your T3 Code chats along?** Give it [Set up T3 Learn with an agent](docs/user/t3-learn-agent-setup.md).

---

_The rest of this README is upstream T3 Code's._

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
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

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

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
