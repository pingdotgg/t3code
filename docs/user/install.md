# Install Hyakki

Hyakki runs coding agents on your computer or server and lets you control them from the desktop app or a web browser. Install Hyakki on the machine where your agents will run first.

## Requirements

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch Hyakki first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

The desktop build bundles the `hyakki` command. The standalone installers below require a Hyakki release archive or a configured Hyakki release mirror. Until public archives are available, use a desktop build or build the CLI from source.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Ryoku-dev/hyakki/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Ryoku-dev/hyakki/main/scripts/install.ps1 | iex
```

Set `HYAKKI_CHANNEL=nightly` for nightly builds or `HYAKKI_VERSION=<ver>` to pin a version.

| Task                          | Command                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| Start server and open web app | `hyakki` (or `hyakki ./my-project`)                                         |
| Start server without browser  | `hyakki serve`                                                              |
| Set up remote access          | `hyakki up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `hyakki service install` ([Background service](./background-service.md))    |
| Update                        | `hyakki update`                                                             |
| Reclaim database space        | `hyakki doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `hyakki uninstall`                                                          |

If `hyakki` reports a server is already running, connect with `hyakki pair` or pass a separate `--base-dir`. Run `hyakki --help` for all commands.

### Intel Macs

There is no standalone `hyakki` binary for Intel Macs—use the desktop app, or build a server from source with `vp` ([development runbook](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/Ryoku-dev/hyakki
cd hyakki && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

## Desktop app

Use a Hyakki artifact from [GitHub Releases](https://github.com/Ryoku-dev/hyakki/releases) when available, or follow the [build instructions](../operations/03_release.md). Packages named `t3code` install upstream T3 Code, not Hyakki.

- **Linux AppImage**: `chmod +x ./Hyakki-*.AppImage && ./Hyakki-*.AppImage`.
- **Debian / Ubuntu**: `sudo apt install ./Hyakki-*.deb`.

### Moving an existing Hyakki home

New installs use `~/.hyakki`. If you already used Hyakki with `~/.t3`, you can keep that location by setting `HYAKKI_HOME` or passing `--base-dir` to the server. To move it on Linux or macOS, first quit Hyakki, T3 Code, and any Hyakki background server. From the Hyakki checkout run `sh scripts/migrate-hyakki-home.sh --confirm-legacy-is-hyakki`, but only if the old directory belongs to Hyakki. The script backs up the directory and keeps a `~/.t3` compatibility link so existing worktree paths still resolve. Do not run upstream T3 Code against that link; configure a different home for it. Existing Electron profiles are kept in place.

### The `hyakki` command

The desktop app bundles `hyakki` and sets it up on first launch (manage anytime under **Settings → About → hyakki command**). Use **Add to PATH** if needed, then open a new terminal.

- **Open a folder in the running desktop app**: Run `hyakki app` (or `hyakki app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL (install provider CLIs inside that distro). Hyakki manages its own server runtime inside WSL automatically.

## Mobile app

Hyakki does not currently ship a mobile app. Use the web app in your phone's browser over [direct remote access](./remote-access.md).

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider         | Install and authenticate                                                                                                 | Guide                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Codex**        | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. | [Codex](./providers-codex.md)             |
| **Claude**       | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                               | [Claude](./providers-claude.md)           |
| **Cursor**       | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                               | [Cursor](./cursor.md)                     |
| **Grok Build**   | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                         | [Grok](./providers-grok.md)               |
| **Antigravity**  | Install managed runtime and sign in with Google in Settings.                                                             | [Antigravity](./providers-antigravity.md) |
| **OpenCode**     | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                   | [OpenCode](./providers-opencode.md)       |
| **Kiro**         | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                 | [Kiro](./providers-kiro.md)               |
| **Pi**           | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                | [Pi](./providers-pi.md)                   |
| **Muse Code**    | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                            | [Muse Code](./providers-muse.md)          |
| **fx**           | Install [fx](https://fx.sh) and run `fx login`.                                                                          | [fx](./providers-fx.md)                   |
| **ACP Registry** | Add GitHub Copilot and other agents in **Settings → Providers → Add provider → Show more**.                              | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during Hyakki's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
HYAKKI_CODEX_PROBE_TIMEOUT_MS=60000 HYAKKI_CLAUDE_PROBE_TIMEOUT_MS=60000 hyakki serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `HYAKKI_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `HYAKKI_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `HYAKKI_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `HYAKKI_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `HYAKKI_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `HYAKKI_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `HYAKKI_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `HYAKKI_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `HYAKKI_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `HYAKKI_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `HYAKKI_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how Hyakki works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating Hyakki](./updating.md): keep apps, servers, and providers up to date.
