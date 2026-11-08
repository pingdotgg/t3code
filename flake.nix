# SPDX-License-Identifier: MIT
# Local T3 Code source build for Nix, mirroring the nixpkgs `t3code`
# package ("as installed now") but built from this checkout instead of a
# GitHub release tarball.
# 
# Usage from a NixOS flake:
# 
#   inputs.t3code-local.url = "path:/path/to/t3code";            # or "git+file://..."
#   outputs = { ... }: {
#     nixosConfigurations.nas = nixpkgs.lib.nixosSystem {
#       modules = [
#         t3code-local.nixosModules.default                  # services.t3code
#         ({ pkgs, ... }: {
#           environment.systemPackages = [
#             t3code-local.packages.${pkgs.stdenv.hostPlatform.system}.default
#           ];
#         })
#       ];
#     };
#   };
# 
# `nix build .#t3code`, `nix build .#default`, or `nix run .#t3` work too.
{
  description = "T3 Code, built from the local checkout";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/1d060086d60cb76a40cf37109f979d88a5bd6396";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          unwrapped = pkgs.callPackage ./nix/unwrapped.nix {
            srcRoot = ./.;
            flakeVersion = self.sourceInfo.shortRev or self.sourceInfo.dirtyShortRev or "dev";
          };
        in
        {
          t3code-unwrapped = unwrapped;
          t3code = pkgs.callPackage ./nix/package.nix {
            t3code-unwrapped = unwrapped;
            t3code-resource-monitor = pkgs.callPackage ./nix/resource-monitor.nix {
              t3code-unwrapped = unwrapped;
            };
          };
          default = self.packages.${system}.t3code;
        }
      );

      apps = eachSystem (system: {
        t3 = {
          type = "app";
          program = lib.getExe self.packages.${system}.t3code;
        };
        t3code-desktop = {
          type = "app";
          program = "${self.packages.${system}.t3code}/bin/t3code-desktop";
        };
      });

      # Drop-in replacement for `unstable.t3code` in `environment.systemPackages`:
      #
      #   nixpkgs.overlays = [ inputs.t3code-local.overlays.default ];
      #
      # Afterwards `pkgs.t3code` is this checkout's build.
      overlays.default = final: _prev: {
        t3code = self.packages.${final.stdenv.hostPlatform.system}.t3code;
      };

      # NixOS module running the bundled `t3` server as a systemd service.
      #
      #   imports = [ inputs.t3code-local.nixosModules.default ];
      #   services.t3code = {
      #     enable = true;
      #     # package = inputs.t3code-local.packages.${system}.default;
      #     user = "alphas";
      #     lan = true;
      #   };
      nixosModules.default = import ./nix/module.nix;
    };
}
