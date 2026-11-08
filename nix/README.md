# T3 Code on Nix, built from this checkout

Same thing you install today (`nix profile add …#t3code` / `unstable.t3code`):
the `t3code-desktop` app plus the `t3` command — but built from **this
repository** instead of the nixpkgs GitHub snapshot. Derivations mirror
[`pkgs/by-name/t3/t3code`](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
in nixpkgs; only `src` comes from the flake.

## What it provides

- `packages.<system>.t3code` — desktop app + `t3` (same layout as nixpkgs).
- `packages.<system>.default` — alias for the above.
- `packages.<system>.t3code-unwrapped` — the raw derivation (debugging).
- `apps.<system>.t3` / `apps.<system>.t3code-desktop` — `nix run .#t3 …`.
- `overlays.default` — makes `pkgs.t3code` this checkout's build.
- `nixosModules.default` — `services.t3code`, the bundled `t3` server as a
  systemd service (declarative counterpart to the mutable
  `t3 service install` unit).

## Build

```bash
nix build .#t3code        # desktop + CLI, like nixpkgs
ls result/bin             # t3, t3code-desktop
result/bin/t3 --version
```

Two fixed-output hashes pin the dependency closures:

| File | Hash | Refresh when |
| ---- | ---- | ------------ |
| `nix/unwrapped.nix` (`pnpmDeps.hash`) | pnpm store | `pnpm-lock.yaml` changes — run `nix build`, copy `got: sha256-…` from the mismatch error |
| `nix/resource-monitor.nix` (`cargoHash`) | cargo vendor | `native/resource-monitor/Cargo.lock` changes — same procedure |

> Both hashes verified against a real build from this checkout — the
> pnpm hash matches `a9e709f`'s lockfile, the cargo hash matches nixpkgs'
> (the Rust sidecar is unchanged between the two).

The build needs network once (fetching npm/crates) and takes a while
(web bundle + server bundle + Electron packaging, roughly 20–60 min on a
fast machine). The sandbox has no network, so unresolved inputs fail fast
instead of hanging.

## Use in your NixOS flake

```nix
{
  inputs.t3code-local.url = "path:/home/alphas/Documents/Projects/_dev/ai/t3code";

  outputs = { nixpkgs, t3code-local, ... }: {
    nixosConfigurations.nas = nixpkgs.lib.nixosSystem {
      modules = [
        t3code-local.nixosModules.default
        ({ pkgs, ... }: {
          # Same as today, but built from your repo:
          environment.systemPackages = [
            t3code-local.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
        })
      ];
    };
  };
}
```

or as a plain overlay replacing `pkgs.t3code`:

```nix
nixpkgs.overlays = [ inputs.t3code-local.overlays.default ];
```

## `services.t3code`

```nix
{
  imports = [ inputs.t3code-local.nixosModules.default ];
  services.t3code = {
    enable = true;
    package = inputs.t3code-local.packages.${pkgs.stdenv.hostPlatform.system}.default;
    user = "alphas";
    home = "/home/alphas/.t3";   # T3 home (like T3CODE_HOME)
    port = 18789;
    host = "127.0.0.1";
    # lan = true; openFirewall = true;
    # environmentFile = "/run/secrets/t3code.env";
  };
}
```

After `nixos-rebuild switch`, the server runs as `systemd.services.t3code`
(`t3 serve --no-browser --base-dir …`). This replaces `t3 service install`;
don't run both for the same `home` — keep using `t3 up` from the terminal
for remote access, it targets whichever server holds the lock.

## Notes

- The packaged app intentionally does **not** come from `t3 update` or the
  in-app updater: Nix owns updates, same as the nixpkgs package. Rebuild
  after `git pull`.
- Electron is taken from nixpkgs (`electron_44`); set
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is already handled by the derivation.
- Dirty git trees build fine, but `git add` the new files you want in the
  build — the source snapshot only contains tracked files.
