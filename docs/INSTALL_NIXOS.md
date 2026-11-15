# Continuum IDE on NixOS

## Run the prebuilt AppImage

Electron AppImages expect an FHS file system. The simplest way is `appimage-run`:

```bash
nix-shell -p appimage-run --run "appimage-run ./Continuum-IDE-x86_64.AppImage"
```

To install it permanently, add `pkgs.appimage-run` to `environment.systemPackages` and enable
binary format registration so AppImages run directly:

```nix
{ pkgs, ... }: {
  programs.appimage = { enable = true; binfmt = true; };
}
```

## Build and run from source

The repository includes a `flake.nix` development shell with everything the desktop app compiles
against (Rust, pkg-config, libsecret, ImageMagick, rpm/dpkg tools) and the shared libraries
Electron loads. It relies on nix-ld, which most NixOS desktop configurations can enable with:

```nix
{ programs.nix-ld.enable = true; }
```

Then:

```bash
git clone https://github.com/SwashX-dev/continuum-ide.git && cd continuum-ide
```

```bash
nix develop
```

Inside the shell, install [Vite+](https://viteplus.dev/guide/) once (`curl -fsSL https://vite.plus | bash`),
then:

```bash
vp i && vp run dev:desktop
```

The shell sets `NIX_LD` to its own glibc, so Electron and the downloaded Node.js load matching
libraries even when the system's nixpkgs is older or newer than the flake's.

## Notes

- Continuum stores data in `~/.continuum`; it does not share state with a `t3code` package.
- The in-app updater cannot replace Nix-managed files. Update by pulling a new release AppImage or
  rebuilding from source.
- A nixpkgs package does not exist yet.
