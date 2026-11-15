# Install Continuum IDE on Linux

Prebuilt packages are 64-bit x86 (`x86_64` / `amd64`). Check with `uname -m`.

## AppImage (any distribution)

```bash
chmod +x ./Continuum-IDE-x86_64.AppImage
./Continuum-IDE-x86_64.AppImage
```

- The AppImage uses the static AppImage runtime, so FUSE 2 (`libfuse2`) is **not** required.
  If your system has no FUSE at all, run it with `--appimage-extract-and-run`.
- On first launch it offers to add a desktop entry so it appears in your app menu.
- Updates replace the AppImage file in place (keep it in a folder you can write to).

## Debian, Ubuntu, Mint, Pop!_OS

```bash
sudo apt install ./Continuum-IDE-amd64.deb
```

This installs `/opt/Continuum IDE`, the `continuum-ide` launcher, a menu entry, and the dependencies
it needs (GTK 3, NSS, ALSA, libsecret, and others). Remove with `sudo apt remove continuum-ide`.
In-app updates ask for your password to install the new `.deb`.

## Fedora, openSUSE, RHEL

When the release includes `Continuum-IDE-x86_64.rpm`:

```bash
sudo dnf install ./Continuum-IDE-x86_64.rpm
```

Otherwise use the AppImage.

## Arch Linux, Manjaro, EndeavourOS

No AUR package is published yet. Use the AppImage.

## NixOS

See [INSTALL_NIXOS.md](./INSTALL_NIXOS.md).

## Desktop compatibility notes

| Topic              | Notes                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Wayland / X11      | Runs natively on both. Window decorations follow your desktop.                                 |
| Credential storage | Uses the Secret Service (GNOME Keyring, KWallet) when available.                               |
| GPU                | Hardware acceleration is used when available; it falls back to software rendering.             |
| Ubuntu 24.04+      | If the AppImage exits with a sandbox error, start it with `--no-sandbox` or use the `.deb`.    |
| Transparency       | **Window transparency** needs a compositing desktop and one restart the first time it is used. |

Data lives in `~/.continuum` (conversations, settings, logs) and `~/.config/continuum-ide`
(in-app browser profile). Continuum never reads or writes T3 Code's `~/.t3` folder.
