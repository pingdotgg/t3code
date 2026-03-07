# T3 Code

T3 Code is a minimal web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for T3 Code to work.

```bash
npx t3
```

You can also just install the desktop app. It's cooler.

Install the [desktop app from the Releases page](https://github.com/pingdotgg/t3code/releases)

## Install (Desktop App)

> [!WARNING]
> All install methods below require [Codex CLI](https://github.com/openai/codex) to be installed and authorized **separately**. T3 Code is a GUI frontend — it does not bundle Codex.

### macOS

```bash
brew install --cask ./packaging/homebrew/Casks/t3code.rb
```

Or download the `.dmg` directly from [Releases](https://github.com/pingdotgg/t3code/releases).

### Arch Linux

```bash
git clone https://github.com/pingdotgg/t3code.git
cd t3code/packaging/arch
makepkg -si
```

This builds and installs the `t3code-bin` package from the PKGBUILD, which downloads the pre-built AppImage from GitHub Releases.

### Linux (Ubuntu / Debian / Others)

There is no `.deb` package yet. The recommended Linux install path is the AppImage:

```bash
curl -LO "https://github.com/pingdotgg/t3code/releases/download/v0.0.3/T3-Code-0.0.3-x86_64.AppImage"
chmod +x T3-Code-0.0.3-x86_64.AppImage
./T3-Code-0.0.3-x86_64.AppImage
```

> **Note:** AppImage requires FUSE. On Ubuntu 22.04+: `sudo apt install libfuse2`

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
