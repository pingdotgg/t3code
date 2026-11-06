---
title: "Install T3 Code on Linux"
description: "Download and install T3 Code on Linux with Debian packages, AppImages, Arch Linux packages, Nix, or the standalone CLI for a web-accessible server."
updated: 2026-11-04
sources:
  - label: "Install T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Linux downloads"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/download.astro"
  - label: "Shell installer"
    url: "https://github.com/pingdotgg/t3code/blob/main/scripts/install.sh"
  - label: "Release artifacts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md"
  - label: "Linux package overview"
    url: "https://github.com/pingdotgg/t3code/blob/main/README.md"
  - label: "Updating T3 Code"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md"
faq:
  - question: "Where is the official T3 Code download for Linux?"
    answer: "The official T3 Code download page is t3.codes/download. It links x64 and arm64 Debian packages and AppImages from pingdotgg/t3code releases."
  - question: "How do I install T3 Code on Ubuntu?"
    answer: "Download the T3 Code DEB for your architecture, then run sudo apt install ./T3-Code-*.deb from its directory. You can also install the standalone CLI for a web interface."
  - question: "Is T3 Code available on Arch Linux?"
    answer: "The documented T3 Code AUR packages are t3code-bin for Stable and t3code-nightly-bin for Nightly. Install them with yay -S and the selected package name."
  - question: "How do I update T3 Code installed through Nix?"
    answer: "Use nix profile upgrade t3code for a T3 Code profile installation. For NixOS or Home Manager, update your nixpkgs input or channel and rebuild; Nix manages both the desktop app and bundled command."
---

T3 Code provides Linux desktop downloads as Debian packages and AppImages for x64 and arm64, plus a standalone CLI. Use [Download T3 Code](/download) for current files, or choose the documented Arch Linux or Nix package for your system.

## Choose a Linux installation method

Use the desktop package when you want T3 Code's desktop interface and bundled server. Choose the CLI for a machine where you want the server and web app without installing the desktop app. Provider CLIs and authentication belong on whichever machine runs that server.

| Linux setup                 | Documented option                           |
| --------------------------- | ------------------------------------------- |
| Debian or Ubuntu            | Download a DEB, then install with apt       |
| Desktop using AppImage      | Download the AppImage for your architecture |
| Arch Linux                  | AUR Stable or Nightly package               |
| Nix, NixOS, or Home Manager | nixpkgs package                             |
| Command-line server         | Official shell installer                    |

The download page's main Debian link selects `amd64.deb`, and its main AppImage link selects `x86_64.AppImage`. Separate ARM links select `arm64.deb` and `arm64.AppImage`. Stable and Nightly have separate selections. See [verify the official download](/learn/start/verify-official-download) before executing a file obtained through search.

## Install T3 Code on Debian or Ubuntu

1. Open [the official download page](/download).
2. Choose the DEB for your release track and architecture.
3. In the directory containing the downloaded package, run the documented command.
4. Open T3 Code and continue through the [welcome wizard](/learn/start/welcome-wizard).

```sh
sudo apt install ./T3-Code-*.deb
```

Keep only the intended matching package in that directory when using the wildcard. The DEB supports in-app updates like the other desktop builds, but each update asks for your password. If your desktop cannot display the password prompt, download the new DEB and install it with the same command.

AppImage downloads are available on the same page for x64 and arm64. Choose the AppImage when that distribution format fits your desktop setup. The release workflow builds both Linux formats for both architectures.

## Install T3 Code on Arch Linux

Choose the package that matches the track you intend to follow. The repository maintains the AUR packaging.

Stable:

```sh
yay -S t3code-bin
```

Nightly:

```sh
yay -S t3code-nightly-bin
```

Do not confuse the product's Beta label with a third user release track. The release documentation defines Stable and Nightly as the desktop channels. A separate Preview train exists for maintainer testing.

## Install with Nix

The documented profile command uses nixpkgs `nixos-unstable`:

```sh
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

It requires Nix 2.30 or later with `nix-command` and `flakes` enabled. Launch the desktop app with `t3code-desktop`. The package also includes `t3`.

On NixOS, add the package through a nixpkgs revision that contains it:

```nix
environment.systemPackages = [ pkgs.t3code ];
```

Apply that configuration with `sudo nixos-rebuild switch`. For Home Manager, add `pkgs.t3code` to `home.packages`, then run `home-manager switch`.

Nix owns updates for the desktop app and bundled CLI. Use `nix profile upgrade t3code` for a profile installation. For NixOS or Home Manager, update the configuration's nixpkgs input or channel and rebuild. Use this path instead of the in-app updater or `t3 update`.

## Install a standalone Linux server

Run the official shell command:

```sh
curl -fsSL https://t3.codes/install.sh | sh
```

The installer supports x64 and arm64 Linux. It needs `sh`, `tar`, `sha256sum` or `shasum`, and `curl` or `wget`. It downloads a self-contained archive, verifies it against `SHA256SUMS`, and installs a `t3` link in `~/.local/bin` by default. It does not need Node.js or a compiler.

If `t3` is not found afterward, add the printed command directory to `PATH`. Run `t3` to start the server and open the web app, or `t3 serve` to avoid opening a browser. With Node.js available, the one-time alternative is:

```sh
npx t3@latest
```

For an explicit Nightly install, use:

```sh
curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh
```

## Connect agents and keep the server available

Enable providers under `Settings → Providers` for this environment. Install and authenticate them on this Linux machine. Set `Binary path` when a version manager prevents the server from finding a CLI.

Use `t3 service install` if you want a supported background service. Follow [background service setup](/learn/safety/background-service) before relying on that machine for remote work. Use [build from source](/learn/open-source/build-from-source) when you need a source checkout rather than a packaged release.

## Next steps

- Complete the [welcome wizard](/learn/start/welcome-wizard), then return to [Get started](/learn/start).
- Read [Update T3 Code](/learn/start/updating) for app and host updates, keeping the Nix exception above in mind.
- Check [official download verification](/learn/start/verify-official-download) before installing another release.
