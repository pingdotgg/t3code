# T3 Code Linux Installer

This is an optional desktop-focused Linux installer bundle for the existing T3 Code AppImage release artifacts. It is not a replacement for the AppImage itself.

## Why this exists

The raw AppImage is still the primary release artifact, but it does not integrate consistently across Linux desktops. This bundle smooths over the gaps that commonly show up in real installs:

- desktop entry and icon setup
- per-user install layout under `~/.local`
- FUSE detection with `--appimage-extract-and-run` fallback
- built-in update, reinstall, and uninstall actions
- GUI dialogs when `zenity` or `kdialog` is available

It is especially useful on systems where AppImage does not quite "just work" out of the box.

## What it does

- downloads the latest `T3-Code-*.AppImage` release from `pingdotgg/t3code`
- verifies the downloaded AppImage checksum when release metadata includes a digest
- installs the AppImage under `~/.local/bin` by default
- installs desktop entries and icons under `~/.local/share`
- keeps a local copy of the installer under `~/.local/share/t3-code/installer`
- adds launcher actions for update, reinstall, and uninstall

## Run it

```bash
chmod +x ./install-t3-code-linux.sh
./install-t3-code-linux.sh
```

## Common options

```bash
./install-t3-code-linux.sh --force
./install-t3-code-linux.sh --no-launch
./install-t3-code-linux.sh --quiet-current
./install-t3-code-linux.sh --system
```

## Bundled assets

- `assets/icons/t3-code-desktop-256.png`
- `assets/icons/t3-code-desktop-512.png`

## Notes

- designed for desktop Linux environments that follow freedesktop menus and icon paths
- installs per-user by default, so no `sudo` is required
- optional `--system` mode installs under `/opt/t3-code` and `/usr/local`
- requires `curl` and `python3`
