# Install Lathe

Lathe runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Lathe and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/latheworks/t3code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/latheworks/t3code/main/scripts/install.ps1 | iex
```

This puts `lathe` in `~/.local/bin` and keeps its data in `~/.lathe`, beside
any upstream Lathe install. A machine that ran the fork before it became Lathe
keeps using its `~/.t3f`; move it to `~/.lathe` yourself while nothing is
running if you want the new name. If `~/.local/bin` is not on your `PATH` yet,
the installer says so and, for zsh, bash on Linux, and fish, prints a command to
add it. On Windows, `lathe` works in the same PowerShell window right away; add
the folder to your `PATH` for new windows. If a `lathe` that the installer or
the desktop app did not create is already there, it leaves that one alone and
stops. Set `LATHE_CHANNEL=nightly` to install the nightly train, or
`LATHE_VERSION` to pin an exact version.

| Task                                  | Command                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| Start the server and open the web app | `lathe`                                                                    |
| Start the server without a browser    | `lathe serve`                                                              |
| Use it from your other devices        | `lathe up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `lathe service install` ([details](./background-service.md))               |
| Move to the newest release            | `lathe update`                                                             |
| Reclaim database space                | `lathe doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                       | `lathe uninstall`                                                          |

Run `lathe help` or `lathe --help` for the full reference. To start in a new working
directory, use an explicit path such as `lathe ./my-project`. A bare directory name
is accepted only if it already exists.

If `lathe` or `lathe start` reports an already running server, run the `lathe pair`
command it names and open the pairing URL to connect to that server. Stop it
before starting a replacement, or use a different `--base-dir` for an
independent server.

To try Lathe once without installing it, run `npx @jamesainslie/lathe@latest` instead (needs
Node.js for `npx`). It offers to install the `lathe` command first. If you say no,
it asks again at the next minor release, and `npx @jamesainslie/lathe install` installs it later.
`npx @jamesainslie/lathe` always runs the version npm picked, even when a `lathe` is installed. On
the nightly train, run your installed `lathe` (for example `lathe connect`), not
`npx @jamesainslie/lathe`, which runs the latest stable release.

### Intel Macs and Windows

The fork ships executables for Apple Silicon Macs and Linux (x64 and arm64).
On an Intel Mac, use the desktop app, or build a server from source with
Node.js 24 and `vp` ([Install vp](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/latheworks/t3code
cd lathe && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`lathe update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/latheworks/t3code/releases).
The fork installs as **Lathe** with its own data directory, so it runs
alongside the upstream desktop app. Builds are published for macOS (Apple
Silicon and Intel) and Linux (AppImage and `.deb`, x64 and arm64).

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`Lathe.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./Lathe.AppImage
./Lathe.AppImage
```

On Debian or Ubuntu, install the `.deb` with `sudo apt install ./Lathe-*.deb`.
Its package is named `lathe`, so it installs beside upstream's `lathe`
package rather than replacing it. The `.deb` updates itself like the other
desktop builds. It asks for your password to install each update. If your
desktop has no password prompt, the update fails. Download the new `.deb` and
install it the same way.

### The `lathe` command

The desktop app includes the `lathe` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**lathe command** in **Settings → About**. On macOS and Linux it adds a `lathe` link
in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to
your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `lathe`, it stays as it is.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. Lathe installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
lathe app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `lathe app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `lathe app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

## Mobile app

Install Lathe from the
[App Store](https://apps.apple.com/us/app/lathe-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.lathetools.lathe).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

Store links and QR codes are also available in **Settings → About → Mobile app**
on web and desktop. The store apps work with both stable and Nightly servers. Test builds are optional:

- **iPhone and iPad:** TestFlight is invite-only.
- **Android:** download an APK from the
  [Android beta releases](https://github.com/pingdotgg/t3code/releases?q=android-beta-).

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

| Provider            | Install and authenticate                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex               | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude              | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor              | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build          | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro                | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode            | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity         | Install and sign in with Google from Lathe's provider settings.                                                                                           |
| Pi                  | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code           | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx                  | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |
| ACP Registry agents | Add GitHub Copilot and other [ACP agents](./providers-acp.md#add-an-agent) from **Settings → Providers → Add provider → Show more**.                      |

Provider CLIs must be on the server's `PATH`. If Lathe cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Lathe warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Lathe cannot tell. Claude, Codex, and
OpenCode installs Lathe cannot identify stay manual: update them through the
installer you used. Lathe runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with Lathe. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release Lathe tested. When Lathe finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Lathe does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), [fx](./providers-fx.md), and
[ACP Registry agents](./providers-acp.md).

### Provider check timeouts

If a provider works in its CLI but Lathe reports a timeout while checking it,
allow more time in the Lathe server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
LATHE_CODEX_PROBE_TIMEOUT_MS=60000 LATHE_CLAUDE_PROBE_TIMEOUT_MS=60000 lathe serve
```

For a remote environment, set these on the machine running the Lathe server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=LATHE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                  |
| ------------------- | ------------------------------------- |
| Codex               | `LATHE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `LATHE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `LATHE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `LATHE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `LATHE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `LATHE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `LATHE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `LATHE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `LATHE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `LATHE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `LATHE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating Lathe](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Lathe for everyone on a machine.
