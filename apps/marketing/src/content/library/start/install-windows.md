---
title: "Install T3 Code on Windows"
description: "Download and install T3 Code on Windows with the desktop installer, winget, Scoop, or PowerShell, then configure local agents or a WSL environment."
updated: 2026-11-04
sources:
  - label: "Install T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Windows package managers"
    url: "https://github.com/pingdotgg/t3code/blob/main/README.md"
  - label: "Official desktop downloads"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/download.astro"
  - label: "PowerShell installer"
    url: "https://github.com/pingdotgg/t3code/blob/main/scripts/install.ps1"
  - label: "Release architecture matrix"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md"
  - label: "Updating T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
faq:
  - question: "Where do I download T3 Code for Windows?"
    answer: "Download T3 Code from t3.codes/download or the pingdotgg/t3code GitHub releases. The download page offers an x64 EXE for Windows 10 and 11; GitHub releases also contain an arm64 installer."
  - question: "Can I install T3 Code with winget or Scoop?"
    answer: "The documented T3 Code commands are winget install T3Tools.T3Code and scoop install extras/t3code. These install the desktop app."
  - question: "Does T3 Code work with WSL?"
    answer: "Choose a WSL distro in T3 Code Settings \u2192 Sharing & access. Install provider CLIs in that distro; T3 Code installs its own server runtime there automatically."
  - question: "Do I need Node.js to install the T3 Code CLI on Windows?"
    answer: "The official T3 Code PowerShell installer needs PowerShell 5.1 or later and downloads a self-contained executable. The npx alternative needs Node.js."
---

T3 Code provides a Windows desktop installer and a standalone command-line installer for Windows. Start from [the official download page](/download), or use the documented winget, Scoop, or PowerShell command for the installation you want.

## Choose a Windows installation path

Use the desktop app when you want T3 Code's desktop interface and bundled server on this computer. Use the standalone CLI when you want to start a server and control it through a web client. WSL is an environment choice inside the desktop app, rather than a requirement for every Windows installation.

| What you want                               | Choose                                      |
| ------------------------------------------- | ------------------------------------------- |
| Desktop app through a downloaded file       | Windows EXE from the official download page |
| Desktop app through a package manager       | winget or Scoop                             |
| Server with a web interface                 | PowerShell CLI installer                    |
| Agents and projects inside Linux on Windows | Desktop app with a selected WSL distro      |

The download page labels its Windows card for Windows 10 and 11 and selects the `x64.exe` asset. The release workflow also builds an `arm64` NSIS installer. Use [the official GitHub releases](https://github.com/pingdotgg/t3code/releases) when you need that architecture, and check [download authenticity](/learn/start/verify-official-download) before running a file from a search result.

## Install the Windows desktop app

1. Open [Download T3 Code](/download).
2. Select Stable or Nightly and choose the Windows installer for your architecture.
3. Run the installer and open T3 Code.
4. Complete the [welcome wizard](/learn/start/welcome-wizard) to select computers, check agents, and import projects.

The documented winget command is:

```powershell
winget install T3Tools.T3Code
```

The README also lists Scoop:

```powershell
scoop install extras/t3code
```

These commands install T3 Code. Provider authentication remains a separate step on the computer or WSL environment where the agent will work.

## Install the CLI with PowerShell

The standalone installer requires PowerShell 5.1 or later. Run:

```powershell
irm https://t3.codes/install.ps1 | iex
```

The script detects x64 or arm64 Windows, downloads the matching release ZIP, and checks its SHA-256 hash against `SHA256SUMS`. It then extracts the executable and checks that it runs. Node.js, npm, and a compiler are not required for this installer.

The default command directory is `~\.local\bin`. The script creates a `t3.cmd` launcher there. If that directory is missing from `PATH`, follow the installer's instruction to add it. This is distinct from installing the desktop command, which can add the app's command folder to `PATH` for you.

After the command is available, start T3 Code:

```powershell
t3
```

That starts the server and opens its web app. Use `t3 serve` to start without a browser. For a one-time run on a machine with Node.js, use:

```powershell
npx t3@latest
```

The download page provides this explicit Nightly command:

```powershell
$env:T3CODE_CHANNEL="nightly"; irm https://t3.codes/install.ps1 | iex
```

The channel variable controls the installer. `T3CODE_VERSION` can pin an exact version instead. Use the Stable path unless you intend to follow Nightly.

## Make the desktop command available

In the desktop app, open `Settings → About` and choose `Install` beside `t3 command`. Windows adds the app's command folder to your `PATH`. Open a new terminal after installing it.

With the desktop app already running on the same computer, `t3 app` opens a new thread for the terminal's current directory. Use `t3 app ../my-project` for another directory. If it cannot reach the app, start or update the desktop app and try again. This command requires a desktop app, rather than only a standalone server.

## Run agents inside WSL

Open `Settings → Sharing & access` and choose the WSL distro that should hold your projects and agents. Install and authenticate provider CLIs inside that distro. T3 Code installs its own server runtime automatically, so the first launch after an app update can take longer.

Check `Settings → Providers` for the selected environment. A provider installed on Windows is not the same installation as one inside WSL. If you choose Codex, follow [the Codex setup guide](/learn/providers/codex) for account and runtime choices.

## Fix a missing provider or version mismatch

A missing provider usually needs installation, authentication, or a corrected `Binary path` on the server's machine. Check that environment before changing the client device.

If the app reports incompatible versions, update the side named in the notice and reconnect. [Update T3 Code](/learn/start/updating) covers connected hosts, manual servers, and failed updates.

## Next steps

- Finish the [welcome wizard](/learn/start/welcome-wizard) and use [Get started](/learn/start) to choose your first workflow.
- Review [official download verification](/learn/start/verify-official-download) and [updating T3 Code](/learn/start/updating) before your next installation change.
