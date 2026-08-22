{
  description = "T3 Code - development shell and desktop package built from this checkout";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }: let
    # The client-only desktop implementation is maintained independently. Only
    # expose its package/overlay when that implementation is in the source.
    clientModeSupported =
      builtins.pathExists ./apps/desktop/src/app/DesktopBackendMode.ts;
    systems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  in
    flake-utils.lib.eachSystem systems (system: let
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

      pnpm = pkgs.pnpm_11;
      nodejs = pkgs.nodejs_24;
      buildCommit =
        if self ? rev
        then self.rev
        else if self ? dirtyRev
        then pkgs.lib.removeSuffix "-dirty" self.dirtyRev
        else "";
      t3codePackages = import ./nix/package.nix {
        inherit buildCommit pkgs self;
      };
      android = import ./nix/android.nix {
        inherit buildCommit nixpkgs self system;
      };
    in {
      packages = t3codePackages;

      apps = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        build-android = android.app;
      };

      # Launch the packaged app headlessly and fail on a renderer crash.
      #
      # A dropped import is a runtime ReferenceError, not a bundler error, so a
      # green `nix build` says nothing about whether the app boots. That has
      # shipped a build whose first paint was "Something went wrong:
      # useEnvironmentSettings is not defined". This check catches that class.
      checks = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        smoke =
          pkgs.runCommand "t3code-smoke" {
            nativeBuildInputs = [pkgs.xvfb-run pkgs.dbus];
          } ''
            export HOME=$(mktemp -d)
            export XDG_RUNTIME_DIR=$(mktemp -d)
            set +e
            timeout 20 xvfb-run -a ${pkgs.dbus}/bin/dbus-run-session \
              --config-file=${pkgs.dbus}/share/dbus-1/session.conf -- \
              ${t3codePackages.t3code}/bin/t3code-desktop \
                ${nixpkgs.lib.optionalString clientModeSupported "--backend-mode=client-only"} \
                --no-sandbox \
              > "$HOME/out.log" 2>&1
            app_status=$?
            set -e

            echo "--- app output ---"; cat "$HOME/out.log" || true

            # A healthy Electron main process stays up until the timeout. An
            # early exit means the launcher failed before the renderer could be
            # checked (for example, a broken D-Bus session).
            if [ "$app_status" -ne 124 ]; then
              echo "SMOKE FAILED: app exited before the timeout (status $app_status)" >&2
              exit 1
            fi

            # Electron logs renderer exceptions to stderr; any of these means the
            # UI failed to mount even if the process exited 0.
            if grep -qE "is not defined|ReferenceError|Something went wrong" "$HOME/out.log"; then
              echo "SMOKE FAILED: renderer crashed on boot" >&2
              exit 1
            fi
            touch $out
          '';
      };

      devShells =
        {
          default = pkgs.mkShell {
            packages = [nodejs pnpm pkgs.git];

            # Electron's postinstall download is useless in a sandbox; point
            # the tooling at the nixpkgs build instead.
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_41}/libexec/electron";

            shellHook = ''
              echo "T3 Code dev shell: node $(node --version), pnpm $(pnpm --version)"
            '';
          };
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          android = android.devShell;
        };

      formatter = pkgs.alejandra;
    })
    // {
      overlays =
        {
          # Build this checkout in place of nixpkgs's released source.
          default = final: _previous: {
            t3code = self.packages.${final.stdenv.hostPlatform.system}.t3code;
          };
        }
        // nixpkgs.lib.optionalAttrs clientModeSupported {
          # Desktop-client installations can opt out of the managed local backend
          # without imposing that policy on every flake consumer.
          client = final: _previous: {
            t3code = self.packages.${final.stdenv.hostPlatform.system}.client;
          };
        };

      homeManagerModules = {
        default = self.homeManagerModules.t3code-server;
        t3code-server = import ./nix/home-manager/t3code-server.nix {inherit self;};
      };
    };
}
