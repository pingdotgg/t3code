<p align="center">
  <img src="./assets/continuum/logo.svg" width="96" height="96" alt="Continuum IDE logo" />
</p>

<h1 align="center">Continuum IDE</h1>

<p align="center">
  One desktop app for all your coding agents. Use the AI subscriptions you already pay for,
  switch agents and accounts without losing your place, and keep everything on your own computer.
</p>

<p align="center">
  <a href="https://github.com/SwashX-dev/continuum-ide/releases/latest"><strong>⬇ Download</strong></a> ·
  <a href="#install-on-windows">Windows</a> ·
  <a href="#install-on-linux">Linux</a> ·
  <a href="#first-time-setup">First-time setup</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="./docs/ROADMAP.md">Roadmap</a>
</p>

---

Continuum IDE is an open-source AI development environment. It runs the coding agents you have
signed in to (Claude Code, OpenAI Codex, Google Antigravity, Cursor, OpenCode, and more) on your
computer and gives them one clean window: start a task in plain English, watch the agent work,
review its changes, and commit them, all without living in a terminal.

Continuum IDE is a community fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc.
It is **not** an official T3 Code release. See [License and attribution](#license-and-attribution).

## Contents

1. [Download](#download)
2. [What it does](#what-it-does)
3. [Install on Windows](#install-on-windows)
4. [Install on Linux](#install-on-linux) — AppImage · Debian/Ubuntu · Fedora · Arch · NixOS
5. [First-time setup](#first-time-setup)
6. [Using multiple accounts](#using-multiple-accounts)
7. [Switching AI agents](#switching-ai-agents)
8. [Tabs and split view](#tabs-and-split-view)
9. [Run models locally with Ollama](#run-models-locally-with-ollama)
10. [Memory vaults](#memory-vaults)
11. [Using the editor, terminal, and browser](#using-the-editor-terminal-and-browser)
12. [Game Development](#game-development)
13. [IWE notes](#iwe-notes)
14. [Supercharge and improve](#supercharge-and-improve)
15. [Mobile Access](#mobile-access)
16. [Entertainment Center](#entertainment-center)
17. [Settings](#settings)
18. [Supported operating systems](#supported-operating-systems)
19. [Building from source](#building-from-source)
20. [Troubleshooting](#troubleshooting)
21. [Updating](#updating)
22. [Contributing](#contributing)
23. [License and attribution](#license-and-attribution)
24. [Roadmap](#roadmap)

## Download

Every installer is on the **[Releases page](https://github.com/SwashX-dev/continuum-ide/releases/latest)**.
Pick the file for your computer:

| Your computer                        | File to download                |
| ------------------------------------ | ------------------------------- |
| Windows 10 or 11 (64-bit)            | `Continuum-IDE-Setup-x64.exe`   |
| Linux, any distribution (64-bit)     | `Continuum-IDE-x86_64.AppImage` |
| Debian, Ubuntu, Linux Mint, Pop!\_OS | `Continuum-IDE-amd64.deb`       |
| Fedora, openSUSE (when attached)     | `Continuum-IDE-x86_64.rpm`      |

Not sure which Linux file? Use the **AppImage**: it works on almost every distribution.

> **Do I need an AI subscription?** You need at least one coding agent you can sign in to, such as a
> Claude Pro/Max plan for Claude Code or a ChatGPT plan for Codex. Continuum IDE does not sell AI
> usage and does not require separate API keys for these subscriptions.

## What it does

These features are working in the current release. Anything not finished yet is listed in the
[Roadmap](#roadmap) instead.

- **Every agent in one window.** Claude Code, OpenAI Codex, Google Antigravity, Cursor, OpenCode,
  Grok Build, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent.
- **Your subscriptions, not API keys.** Continuum drives the official agents with their own sign-in.
  Codex and Antigravity can be installed and signed in to from inside the app.
- **Multiple accounts.** Add several accounts for the same agent (for example a work and a personal
  Claude account), name them, and choose which one a conversation uses.
- **Always the newest models.** When Claude Code or Codex on your computer is too old to offer the
  latest models, Continuum runs a current build from the vendor instead, without touching your own
  install or sign-in ([details](#keeping-agents-up-to-date)).
- **Local models with Ollama.** Install Ollama, browse models with hardware checks, download them,
  and use them as a full coding agent, all from Settings → Local models.
- **Memory vaults.** Plain Markdown notes that agents read and keep up to date, chosen per
  conversation and kept apart from your project folder.
- **Switch agents mid-task.** Change the agent or model in the middle of a conversation. Continuum
  hands the new agent the important parts of the conversation so it can keep going.
- **Conversations that survive restarts.** Every conversation ("thread") is saved locally. Search,
  pin, rename, archive, and resume them later.
- **Review before you keep.** Every agent turn is checkpointed. See the diff, undo a turn, and commit,
  push, or open a pull request with one click. Agents can work in separate Git worktrees.
- **Built-in terminal, file browser, browser, and live preview.** Run your app and see it update
  next to the conversation. Point at an element in the preview to tell the agent what to change.
- **Usage dashboard.** Token use and cost estimates from the agents' local history.
- **Themes and window transparency.** Light, dark, or system theme, custom themes, accent contrast,
  and an adjustable **window transparency** slider.
- **Local first and private by default.** Your projects, conversations, and settings stay on your
  computer. Continuum sends **no usage analytics** unless you opt in
  ([privacy notice](./docs/PRIVACY.md)).
- **Remote ready.** Control a Continuum server on another machine from this app (local network,
  Tailscale, or SSH).

## Install on Windows

1. Open the **[Releases page](https://github.com/SwashX-dev/continuum-ide/releases/latest)**.
2. Under **Assets**, click **`Continuum-IDE-Setup-x64.exe`** to download it.
3. Open the downloaded file.
4. Windows may show **"Windows protected your PC"**. This appears because the installer is **not
   digitally signed** (code-signing certificates cost money and this is a community project).
   Click **More info**, then **Run anyway**. Only do this for files downloaded from the official
   Releases page linked above.
5. The installer runs and creates Start-menu and desktop shortcuts.
6. Open **Continuum IDE** from the Start menu.
7. Continue with [First-time setup](#first-time-setup).

**Uninstall:** Settings → Apps → Installed apps → Continuum IDE → Uninstall. Your conversations and
settings in `%USERPROFILE%\.continuum` are kept, so a reinstall picks up where you left off. Delete
that folder too if you want to remove everything.

More detail: [docs/INSTALL_WINDOWS.md](./docs/INSTALL_WINDOWS.md) (WSL, troubleshooting).

## Install on Linux

### AppImage (works on most distributions)

1. Download **`Continuum-IDE-x86_64.AppImage`** from the
   [Releases page](https://github.com/SwashX-dev/continuum-ide/releases/latest).
2. Open a terminal in your Downloads folder and run:

```bash
chmod +x ./Continuum-IDE-x86_64.AppImage
```

```bash
./Continuum-IDE-x86_64.AppImage
```

The AppImage includes its own runtime, so it does not need FUSE 2. If your desktop asks, allow it to
add a menu entry. On Ubuntu 24.04 and newer, if the app closes immediately with a sandbox message,
see [Troubleshooting](#troubleshooting).

### Debian, Ubuntu, Linux Mint, Pop!\_OS (.deb)

1. Download **`Continuum-IDE-amd64.deb`** from the
   [Releases page](https://github.com/SwashX-dev/continuum-ide/releases/latest).
2. Install it from the folder you downloaded it to:

```bash
sudo apt install ./Continuum-IDE-amd64.deb
```

3. Open **Continuum IDE** from your applications menu, or run `continuum-ide`.

Remove it with `sudo apt remove continuum-ide`.

### Fedora, openSUSE (.rpm)

When a release includes **`Continuum-IDE-x86_64.rpm`**, install it with:

```bash
sudo dnf install ./Continuum-IDE-x86_64.rpm
```

If a release has no `.rpm`, use the AppImage.

### Arch Linux and Manjaro

There is no AUR package yet. Use the AppImage (above). To add it to your menu, an AppImage
integration tool such as Gear Lever works, or run it once and accept the desktop entry prompt.

### NixOS

The AppImage needs an FHS-style environment on NixOS. With `appimage-run`:

```bash
nix-shell -p appimage-run --run "appimage-run ./Continuum-IDE-x86_64.AppImage"
```

For a permanent setup, building from source, and the included development shell, see
[docs/INSTALL_NIXOS.md](./docs/INSTALL_NIXOS.md).

Full Linux guide: [docs/INSTALL_LINUX.md](./docs/INSTALL_LINUX.md).

## First-time setup

The first launch opens a **Welcome** page that walks you through these steps.

### 1. Connect an AI agent

Continuum controls agents that are installed and signed in on your computer. Set up at least one.
You can do all of this later from **Settings → Providers**.

| Agent                                           | How to connect                                                                                                                                     | Needs a separate install?                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **OpenAI Codex**                                | **Settings → Providers → Codex → Connect with ChatGPT**, or install the [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login` | No. Continuum can install and manage Codex for you |
| **Anthropic Claude Code**                       | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login` once                                                   | Yes, Claude Code                                   |
| **Google Antigravity**                          | **Settings → Providers → Antigravity → Install**, then **Sign in** with Google                                                                     | No. Continuum installs it                          |
| Cursor, OpenCode, Grok, Kiro, Pi, Muse Code, fx | Install the agent's CLI and sign in once (details in [docs/PROVIDERS.md](./docs/PROVIDERS.md))                                                     | Yes                                                |

When an agent shows **Ready**, it is connected. If an agent is installed but not detected, see
[Provider not detected](#provider-not-detected).

### 2. Open a project

Click **Add project** in the sidebar and choose a folder, or drag a folder onto the sidebar.
To start from a GitHub repository, use **Clone repository** in the command palette (`Ctrl+K`).

### 3. Start your first conversation

1. Select the project in the sidebar and click **New thread** (or press `Ctrl+N`).
2. Under the message box, pick the **agent**, **account**, and **model**. Only models your account
   can actually use are listed.
3. Describe what you want in plain English, for example: _"Add a dark-mode toggle to the settings
   page."_ Press **Enter**.
4. Watch the agent work. When it asks for permission (to run a command or edit files), approve or
   decline it. Change how much the agent may do on its own with the **permission mode** next to the
   model picker ([permission modes](./docs/user/permission-modes.md)).
5. Open the **Diff** panel to review the changes, then **Commit** when you're happy.

## Using multiple accounts

Continuum treats each account as its own **provider instance**.

- **Add an account:** Settings → Providers → **Add instance** (or **Add Claude account** /
  **Add Codex account**). Give it a name such as "Claude Personal".
- **Claude:** each account needs its own Claude config folder. Sign in once in a terminal:
  `CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login`, then set that folder on the instance.
- **Codex:** add a second ChatGPT connection from **Add Codex account**.
- **Choose per conversation:** the model picker groups models by account; pick the account and
  model for each conversation.
- **Default account:** Settings → Threads → **Default model** picks the account and model new
  conversations start with. **Fallback model** is offered while the default is at its limit.
- **Usage limits:** when an account hits its limit, the conversation shows the reset time and can
  resume by itself when the limit resets. It also offers **Continue on …** buttons for your other
  signed-in accounts (same agent first) that still have room. Clicking one selects it; your next
  message continues the conversation there.

Limits: an existing conversation can move between accounts of the same agent only when they share
the same configuration folder; otherwise switching starts a fresh agent session that receives a
summary of the conversation (see below). Continuum never switches accounts by itself, and never
works around a provider's usage limits.

## Switching AI agents

Open the model picker in a conversation and choose a model from a different agent, for example from
Claude to Codex. Continuum:

1. keeps the full conversation in the thread,
2. sends the new agent a **handoff**: your original request, recent messages, and relevant activity
   such as command results, within the new model's context budget,
3. continues with your next message, and records the switch in the thread.

The new agent does not receive the old agent's private reasoning or tool state; providers do not
export those. For long or important tasks, restate key requirements in your next message. Details:
[portable handoffs](./docs/user/portable-handoffs.md).

## Tabs and split view

Every thread you open gets a tab under the thread's title, like a web browser. Tabs are remembered
when you restart Continuum.

- **Switch:** click a tab, or press `Ctrl+Tab` / `Ctrl+Shift+Tab`.
- **Close and reopen:** click ×, middle-click the tab, or press `Ctrl+Alt+W` (`Cmd+Option+W` on
  macOS). `Ctrl+Alt+T` reopens the last closed tab.
- **Reorder:** drag a tab. Right-click a tab to **pin** it (pinned tabs stay first), close other
  tabs, or close tabs to the right.
- **Split view:** right-click a tab → **Open beside current thread** to work in two threads side by
  side. Drag the divider to resize, use ⇄ to swap the two, or × to close the split. Split view needs
  a window at least 768 pixels wide.

Shortcuts can be changed in Settings → Keybindings.

## Run models locally with Ollama

Run open models on your own computer, with no account and nothing sent to the cloud.

1. Open **Settings → Local models**. Continuum shows your graphics card and memory.
2. Click **Install Ollama** (or use an Ollama you already have running).
3. Browse the model list. Each model shows its size and whether it fits your hardware. Click
   **Download** and watch the progress.
4. Turn on **Use local models in agents**. A provider called **Ollama (local)** appears in the
   model picker, and its models can read and edit files and run commands like any other agent.

Good to know: small models (1–8B) work best for simple tasks and can be slow without a graphics card
with enough memory (an 8B model wants about 6 GB). Continuum runs agent models with a 32K context so
long agent instructions are not cut off. Remove models from the same page to free disk space.

## Memory vaults

A memory vault is a folder of Markdown notes (project overview, architecture, decisions, tasks,
bugs and fixes, history, preferences) that agents read before they answer and keep up to date.

- **Pick a vault per conversation** with the brain button under the message box: create a vault,
  reuse one from another project, or choose none. Choosing a vault never changes the project,
  folder, branch, or files the conversation works on.
- **Choose what the agent may do:** read and update, read only, or reference only (the agent can
  search the vault when it needs to, but nothing is added up front).
- **Only relevant notes are sent.** Continuum picks the sections that match your message and stays
  within a size budget. Ask for "the whole vault" to send all of it.
- **Manage vaults** in Settings → Memory vaults: edit notes, search, rename, export, import, delete,
  set a default vault, and choose where vaults are stored (by default in `~/.continuum/memory-vaults`).
- Notes are plain files you can open in any editor. Continuum writes them atomically and removes
  things that look like keys or passwords before saving.

## Using the editor, terminal, and browser

- **Files and diffs:** the right-hand panel shows changed files and diffs for each agent turn, with
  a file browser for the project. Open a file in your own editor (VS Code, Zed, JetBrains, and
  others) with **Open in**.
- **Terminal:** press `Ctrl+J` for a terminal in the project folder. Terminals keep running while
  you switch between conversations.
- **Browser and live preview:** start your dev server from **Project scripts** (or the terminal),
  then open the **Browser** tab in the right panel. Continuum detects local servers such as
  `localhost:3000` and `localhost:5173`. Use the element picker to select something on the page
  and ask the agent to change it.
- **Agent access to the browser** is permission-controlled; web pages cannot instruct the agent to
  run commands.

## Game Development

Open **Settings → Game Development** and choose the environment that runs your editor. The page shows
detected installs, launcher requirements, and platform-specific setup. Use **Locate** to register an
editor installed outside its default directory. Launch the project from this page to install the
Continuum bridge. Unity version upgrades require confirmation.

| Tool          | Windows                           | macOS                             | Linux                                                                                |
| ------------- | --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| Roblox Studio | Local                             | Local                             | Connect to a Windows or Mac environment                                              |
| Unity         | Local through Unity Hub           | Local through Unity Hub           | Local through Unity Hub on supported distributions. NixOS uses the community package |
| Unreal Engine | Local through Epic Games Launcher | Local through Epic Games Launcher | Download the Linux build from Epic and locate the editor                             |
| Blender       | Local                             | Local                             | Local through the vendor build or distribution package                               |
| ForgeGUI      | Optional Roblox asset service     | Optional Roblox asset service     | Optional Roblox asset service. Importing into Studio needs a connected editor        |

Open an existing thread for the project and choose **+ → Game Development** in its right panel.
Select the editor, or bind a Roblox Studio place after connecting the installed plugin. The workspace
shows captures, builds, playtests, logs, approvals, checkpoints, and asset revisions. Add a recipe to
the composer to review its prompt before sending it. Use **Agent Eyes** to see Game Development
tool calls and their viewport captures.

Install Blender under **Roblox asset tools** for local model generation and revision previews. To
use ForgeGUI, create an MCP API key with the scopes needed for your work, then save it in the same
settings section. Enable publishing only if you want to approve uploads from Continuum.
[ForgeGUI setup](https://github.com/elwinhe/forgegui-plugins/blob/release/claude-mcp-v1/SETUP.md)

## IWE notes

Use **Add project → Open IWE Workspace** to open a folder containing `.iwe/config.toml`, or
**New IWE Workspace** to initialize one. Start a thread, open its right panel, and choose
**+ → Notes (IWE)**. If the environment is missing IWE, use **Install IWE for Continuum** or
follow the setup instructions for that host.

Search by title or text, follow links and backlinks, and edit Markdown with suggestions from
`iwes`. Save an edit before renaming a link target. **Attach to session** includes the note and
the selected depth of related notes with the next message. The activity list shows the agent's
searches, reads, and updates when it uses the IWE tools.

## Supercharge and improve

- **Supercharge** lives in the model picker on a started thread. **Verify** and **Deep** run
  follow-up checks, fixes, and reviews within the limits you set. See progress and the stop
  reason in the same control, or choose **Stop** to end the current run.
- **`/improve <prompt>`** opens a dialog in a started thread. Select an improver and a destination
  model. Continuum rewrites the prompt with context from the current thread and opens the
  destination in a new tab. Use **`/improve`** to revisit previous jobs and retry a failed step.

## Mobile Access

Open **Settings → Mobile Access** and select the server the phone will connect to. Enable network
access or choose a reachable endpoint, create a pairing link, and scan the QR code in T3 Code's
Add Environment screen. Use the same page to review or revoke clients and diagnose expired
credentials or protocol mismatches.

## Entertainment Center

Open Entertainment Center from the thread sidebar. Dock it on either side, drag the edge to resize
it, or collapse it from the header. Paste a YouTube video link to open an embed and use the star to
save it to favorites. The desktop app plays supported sites in a separate browsing session. DRM
services open in your system browser. Signal Weave, Orbit Freight, and Tempo Relay play in the panel.

For platform build and workflow coverage, see the
[Continuum test matrix](./docs/operations/continuum-test-matrix.md).

## Settings

Open **Settings** from the sidebar (or search for any setting with `Ctrl+K`). The most important
sections:

| Section                                   | What you can change                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| **General**                               | Startup behavior, confirmations, notifications                                                |
| **Appearance**                            | Theme, light/dark/system, contrast, glass opacity, **window transparency**, fonts, animations |
| **Providers**                             | Connect agents, add accounts, binary paths, environment variables, models                     |
| **Chat**                                  | Send shortcut, follow-up behavior, how much tool activity is shown                            |
| **Browser**                               | Default browser profile, search engine, viewport, link handling                               |
| **Projects / Worktrees / Source control** | Project scripts, worktree defaults, Git hosting accounts                                      |
| **Sharing & access**                      | Remote access to this computer (off by default)                                               |

### Window transparency

**Settings → Appearance → Window transparency** makes the whole window see-through, from 100%
(fully opaque) down to 30%. It is saved and restored on the next launch.

- **Windows and macOS:** changes apply instantly while you drag the slider.
- **Linux:** the first time you lower it, click **Restart Continuum IDE** once; after that the slider
  works instantly. This needs a compositing desktop (GNOME, KDE Plasma, Hyprland, niri, Sway, and
  most modern desktops). The in-app browser and preview stay opaque on Linux.

## Supported operating systems

| System                        | Status                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Linux x64 (AppImage, .deb)    | Built in CI. Desktop app tested in development mode on NixOS (Wayland, niri).     |
| Windows 10/11 x64 (installer) | Built in CI. Not yet tested by hand on a Windows machine; please report problems. |
| macOS                         | Builds from source (upstream support is kept). No prebuilt download yet.          |
| Linux ARM64, Windows ARM64    | Builds from source. No prebuilt download yet.                                     |

## Building from source

Prerequisites: Git, [Vite+](https://viteplus.dev/guide/) (installs the exact Node.js and pnpm
versions for you), and for the desktop app: Rust (`cargo`), a C compiler, `make`, `pkg-config`,
`libsecret-1-dev`, and ImageMagick on Linux.

```bash
git clone https://github.com/SwashX-dev/continuum-ide.git
```

```bash
cd continuum-ide && vp i
```

```bash
vp run dev:desktop
```

`vp run dev` starts the server and web app only. To build installers:
`vp run dist:desktop:artifact --platform linux --target AppImage --arch x64` (or `--platform win
--target nsis`). On NixOS, run `nix develop` first. Full guide:
[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Troubleshooting

### Provider not detected

- Make sure the agent works in a terminal first (`claude --version`, `codex --version`).
- Agents installed with a version manager (nvm, mise, asdf) may not be on the app's `PATH`. Set the
  full path in **Settings → Providers → (agent) → Binary path**.
- Click the refresh button on the provider card after installing.

### Login failure

- Sign in from a terminal with the agent's own command (`claude auth login`, `codex login`), then
  refresh the provider card.
- For **Connect with ChatGPT** and Antigravity, finish the browser sign-in in the same computer. If
  the last page fails to load, copy its full address into the sign-in panel in Continuum.

### Application does not launch

- **Linux, sandbox error on Ubuntu 24.04+:** run the AppImage with `--no-sandbox`, or install the
  `.deb`, which sets up the sandbox correctly.
- **Linux, missing libraries:** install `libgtk-3-0 libnss3 libasound2 libgbm1 libsecret-1-0`
  (package names vary by distribution).
- Logs are in `~/.continuum/userdata/logs` (Windows: `%USERPROFILE%\.continuum\userdata\logs`).

### Windows installation warnings

"Windows protected your PC" appears because the installer is unsigned. Choose **More info → Run
anyway**. Antivirus tools sometimes flag new unsigned apps; you can verify the download against
`SHA256SUMS` on the release page with `Get-FileHash .\Continuum-IDE-Setup-x64.exe`.

### Agent execution failure

Open the provider card in **Settings → Providers** for the exact error. Common causes: an outdated
agent version (use **Update now**), a usage limit on the account, or a project folder the agent
cannot access.

### Unable to restore a session

Conversations live in `~/.continuum/userdata/statev2.sqlite`. If a conversation cannot resume its
agent session, send a new message: Continuum starts a fresh agent session with a handoff of the saved
conversation. Never delete the database while the app is running.

## Updating

### Keeping agents up to date

New models often need a newer Claude Code or Codex. With **Settings → Provider updates** set to
**Keep up to date** (the default), Continuum checks at startup and every 6 hours. When an agent is
outdated it downloads the current build from the vendor (Claude Code from Anthropic's release server,
checked against its published SHA-256; Codex from OpenAI's releases) into `~/.continuum/tools` and
uses that copy. Your sign-in and conversations carry over.

- Your own install is never changed. Agents set to a custom program path are left alone.
- **Use my installed CLI** on that page switches an agent back to your own copy.
- **Update my installed CLIs** (off by default) also updates copies you installed with npm, Homebrew,
  mise, or similar, using that tool. System packages such as Nix or apt are never changed.
- Choose **Only show updates** or **Off** to manage versions yourself.

### Updating Continuum

Continuum checks this repository's GitHub Releases for updates and offers to install them
(Windows installer, AppImage, and `.deb`). Updates keep your settings, accounts, and conversations,
which live in `~/.continuum`, outside the app folder. To update by hand, download the newest file
from the Releases page and install it over the old one. Continuum never downloads updates from
upstream T3 Code.

## Contributing

Bug reports, ideas, and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md), open an
issue describing the problem or idea, then send a focused pull request. Run `vp run check:changed`
before pushing.

## License and attribution

Continuum IDE is released under the [MIT License](./LICENSE). It is built on
[T3 Code](https://github.com/pingdotgg/t3code), © 2026 T3 Tools Inc., also MIT-licensed; the
original copyright notice is kept in [LICENSE](./LICENSE). Continuum IDE is an independent
community fork and is not affiliated with or endorsed by T3 Tools Inc. Third-party notices are in
[third-party-licenses](./third-party-licenses).

The optional T3 Connect relay and the T3 Code mobile app are services of T3 Tools Inc.; Continuum
keeps compatibility with them but does not operate them.

## Roadmap

**Done**

- Independent identity: name, icons, app ID, installers, data folder (`~/.continuum`), and update
  feed, fully separate from any T3 Code installation
- Automatic agent updates so the newest Claude and Codex models appear
- Local models through Ollama, usable as a full agent
- Memory vaults
- Browser-style thread tabs (drag, pin, close and reopen, saved across restarts) and split view
- Default account and **Continue on …** switching when an account hits its limit
- Window transparency setting
- Analytics off by default, no third-party endpoint
- Windows and Linux installers built and published by GitHub Actions; Nix development shell

**Planned** (not available yet)

- Tabs for the editor, terminal, browser, and settings, and more than two panes
- Agent Eyes: follow an agent's edits, commands, and browser activity live, with replay
- Built-in code editor (Monaco) with search and replace
- A single Account Manager page
- Adaptive Intelligence Engine (optimization profiles)
- Simple and Advanced interface modes

The full plan and status: [docs/ROADMAP.md](./docs/ROADMAP.md).
