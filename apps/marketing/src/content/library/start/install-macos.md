---
title: "Install T3 Code on macOS"
description: "Download and install T3 Code on macOS with the correct Apple Silicon or Intel desktop build, Homebrew, or the Apple Silicon command-line installer."
updated: 2026-11-04
sources:
  - label: "Install T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Official download page"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/download.astro"
  - label: "Command-line installer"
    url: "https://github.com/pingdotgg/t3code/blob/main/scripts/install.sh"
  - label: "Release artifacts and channels"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md"
  - label: "Updating T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
faq:
  - question: "Where is the official T3 Code download for macOS?"
    answer: "Use t3.codes/download for T3 Code macOS downloads. It links the arm64 DMG for Apple Silicon and the x64 DMG for Intel Macs from the official GitHub release."
  - question: "Can I install T3 Code with Homebrew?"
    answer: "Install the T3 Code desktop app with brew install --cask t3-code. The desktop app can also expose its bundled t3 command through Settings \u2192 About."
  - question: "Does the T3 Code CLI work on Intel Macs?"
    answer: "There is no standalone T3 Code executable for Intel Macs. Use the x64 desktop app, or build a server from source using the documented vp workflow."
  - question: "Does the macOS T3 Code installer need Node.js?"
    answer: "The standalone T3 Code installer downloads a self-contained executable and does not need Node.js. Running npx t3@latest requires Node.js and is subject to the Intel Mac binary limitation."
---

T3 Code has macOS desktop downloads for Apple Silicon and Intel Macs, plus a standalone CLI for Apple Silicon. Start from [the official T3 Code download page](/download), choose your processor's build, and configure a provider on the Mac that will run your agents.

## Choose the right macOS download

The download page offers Stable and Nightly tracks. Its main macOS card is the Apple Silicon `arm64.dmg`. The Intel link selects the `x64.dmg`. Both are desktop builds; the missing Intel standalone executable does not prevent you from using the Intel desktop app.

| Your Mac or task                  | Installation path          |
| --------------------------------- | -------------------------- |
| Apple Silicon desktop             | arm64 DMG or Homebrew cask |
| Intel desktop                     | x64 DMG or Homebrew cask   |
| Apple Silicon command-line server | Official shell installer   |
| Intel command-line server         | Build from source          |

For a download obtained through search, follow [verify the official download](/learn/start/verify-official-download) before running it. The official website is `t3.codes`, and its desktop assets come from `pingdotgg/t3code` on GitHub.

## Install the macOS desktop app

1. Open [Download T3 Code](/download).
2. Choose Stable or Nightly, then the DMG for your Mac's processor.
3. Open the disk image and install the desktop app in Applications.
4. Launch T3 Code and complete the [welcome wizard](/learn/start/welcome-wizard).

If you use Homebrew, the documented desktop command is:

```sh
brew install --cask t3-code
```

The desktop app includes the server, so you do not need a separate standalone server for local desktop use. You can configure providers after opening the app, but you need an installed, authenticated provider before starting a thread.

## Install the CLI on Apple Silicon

Run the official shell installer on the Mac that will host the agents:

```sh
curl -fsSL https://t3.codes/install.sh | sh
```

The script downloads a self-contained release archive and checks it against the release's `SHA256SUMS` before extraction. It needs `sh`, `tar`, a SHA-256 utility, and a downloader. It does not need Node.js, npm, or a compiler.

By default, the installer puts the `t3` link in `~/.local/bin`. If your shell reports `command not found`, add the directory printed by the installer to your `PATH`. Then run:

```sh
t3
```

This starts the server and opens its web app. Use `t3 serve` when you want the server without opening a browser. For a one-time run with Node.js available, the documented alternative is:

```sh
npx t3@latest
```

The npm launcher downloads the same platform archive, so it does not provide an Intel Mac workaround. On Apple Silicon, you can request Nightly explicitly:

```sh
curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh
```

## Run a server on an Intel Mac

Use the desktop app unless you specifically need to run a server from source. The installation documentation gives this sequence after installing `vp` through the repository's setup instructions:

```sh
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

That source-run server has a different update path. Use `git pull` and rebuild it. `t3 update` and the background service do not apply to this form of server.

## Make the desktop command available in Terminal

Open `Settings → About` and choose `Install` next to `t3 command`. On macOS, this adds a `t3` link to a folder on your `PATH`. Open a new terminal afterward. Choose `Remove` in the same place to take it off again. An existing npm installation stays as it is.

With the desktop app already running on the same Mac, use `t3 app` to open a new thread for the current directory. Pass another directory with `t3 app ../my-project`. This command requires the desktop app; an SSH session or standalone server alone is insufficient.

## Check agents and plan updates

Use `Settings → Providers` for the environment that runs your work. Install and sign in there. If a version manager keeps a CLI off the server's `PATH`, set the provider's `Binary path`.

Read [Update T3 Code](/learn/start/updating) before changing tracks or updating connected computers. The app and server must speak compatible protocols. For the launch context behind the product, see [Theo's alpha launch](/learn/videos/its-finally-here).

## Next steps

- Complete the [welcome wizard](/learn/start/welcome-wizard) and return to [Get started](/learn/start) for your first thread.
- Keep [official download verification](/learn/start/verify-official-download) and [update instructions](/learn/start/updating) available for future installs.
