# Install Ada

Ada runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Ada and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/jayleaton/ada/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/jayleaton/ada/main/scripts/install.ps1 | iex
```

This installs the `ada` command, and `t3` beside it for existing scripts, to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. On Windows, `ada` works in the same PowerShell window right
away; add the folder to your `PATH` for new windows. If an `ada` or `t3` that
the installer or the desktop app did not create is already there, it leaves
that one alone and installs the other; it stops only when both are taken.

Every Ada release is a nightly, so the installer follows the nightly
channel. To pin an exact version, set `T3CODE_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/jayleaton/ada/main/scripts/install.sh | T3CODE_VERSION=<version> sh
```

```powershell
$env:T3CODE_VERSION="<version>"; irm https://raw.githubusercontent.com/jayleaton/ada/main/scripts/install.ps1 | iex
```

Each [release](https://github.com/jayleaton/ada/releases) also carries
`install.sh` and `install.ps1`. Use only these scripts: T3 Code's
installers and its npm package install T3 Code's server and replace Ada's.

For a headless host, run the installer and then `ada service install`. The
background service is the only headless setup that the app's **Update** button
can update ([details](./background-service.md)). Hosts that already run the
AppImage-based systemd unit can keep following
[Headless Linux host](../operations/headless-linux.md).

| Task                                  | Command                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Start the server and open the web app | `ada`                                                                    |
| Start the server without a browser    | `ada serve`                                                              |
| Use it from your other devices        | `ada up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `ada service install` ([details](./background-service.md))               |
| Move to the newest release            | `ada update`, or `ada update <version>`                                  |
| Reclaim database space                | `ada doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                       | `ada uninstall`                                                          |

Run `ada help` or `ada --help` for the full reference. To start in a new working
directory, use an explicit path such as `ada ./my-project`. A bare directory name
is accepted only if it already exists.

If `ada` or `ada start` reports an already running server, run the `ada pair`
command it names and open the pairing URL to connect to that server. Stop it
before starting a replacement, or use a different `--base-dir` for an
independent server.

### Intel Macs

There is no `ada` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](https://github.com/jayleaton/ada#install-vp)):

```bash
git clone https://github.com/jayleaton/ada
cd ada && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`ada update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/jayleaton/ada/releases):
a `.dmg` for macOS, an `.exe` for Windows, and an AppImage or `.deb` for Linux.
On Debian or Ubuntu, install the `.deb` with `sudo apt install ./Ada-*.deb`.
Package managers such as winget, Homebrew, the AUR, and Nix install T3 Code,
not Ada.

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`Ada.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./Ada.AppImage
./Ada.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `ada` command

The desktop app includes the `ada` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**ada command** in **Settings → About**. On macOS and Linux it adds `ada` and `t3` links
in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to
your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `ada` or `t3`, it stays as it is. `t3` runs the same
command, so existing scripts and services keep working.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Environments** to run agents and projects
there. Install the provider CLIs inside that distro. Ada installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
ada app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `ada app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `ada app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

Ada's mobile app is not in the App Store or Google Play yet. The phone connects
to an Ada server on another machine. Follow [remote access](./remote-access.md) to
pair it with a pairing URL or QR code. Until it is listed, iPhone and iPad test
builds are available through TestFlight by invitation. There is no public Android
build yet.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Ada's provider settings.                                                                                             |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If Ada cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Ada warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Ada cannot tell. Claude, Codex, and
OpenCode installs Ada cannot identify stay manual: update them through the
installer you used. Ada runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with Ada. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release Ada tested. When Ada finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Ada does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but Ada reports a timeout while checking it,
allow more time in the Ada server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 ada serve
```

For a remote environment, set these on the machine running the Ada server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating Ada](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Ada for everyone on a machine.
