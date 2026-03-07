# Arch Linux Packaging (AUR)

This directory contains the AUR-ready `PKGBUILD` for the `t3code-bin` binary package.

## How it works

The package downloads the pre-built AppImage from GitHub Releases, extracts it,
and installs it to `/opt/t3code/` with a launcher symlink at `/usr/bin/t3code`.

## Publishing to AUR

1. Create the AUR package repository: `t3code-bin`
2. Copy `PKGBUILD` and `t3code.desktop` into the AUR repo
3. Generate `.SRCINFO`: `makepkg --printsrcinfo > .SRCINFO`
4. Push to AUR

## Updating for a new release

1. Update `pkgver` in `PKGBUILD`
2. Download the new AppImage and compute its SHA256:
   ```bash
   curl -sL "https://github.com/pingdotgg/t3code/releases/download/v<VERSION>/T3-Code-<VERSION>-x86_64.AppImage" | sha256sum
   ```
3. Update `sha256sums` in `PKGBUILD`
4. Bump `pkgrel` back to `1` (new upstream version)
5. Regenerate `.SRCINFO` and push

## Prerequisites

Users must install and authorize [Codex CLI](https://github.com/openai/codex)
separately. T3 Code is a GUI frontend — it does not bundle Codex.
