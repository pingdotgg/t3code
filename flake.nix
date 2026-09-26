{
  description = "T3 Code development shell";

  inputs = {
    # nixpkgs-unstable branch; the resolved revision is pinned by flake.lock.
    # Regenerate with: nix flake lock   (or bump with: nix flake update nixpkgs)
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems =
        function:
        nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
          system: function nixpkgs.legacyPackages.${system}
        );
    in
    {
      formatter = forAllSystems (pkgs: pkgs.alejandra);

      devShells = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib;
        in
        {
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                # Node 24 (engines.node in package.json) + pnpm for `vp i`.
                nodejs_24
                pnpm

                # The `vp` repo task runner (installed separately, see below).
                # Rust stable: native/resource-monitor (cargo fmt + test run in CI).
                cargo
                rustc
                rustfmt
                clippy

                # node-gyp fallback for node-pty (its prebuilds are mac/win only).
                python3
                gnumake
              ]
              ++ lib.optionals stdenv.hostPlatform.isLinux [
                gcc
                pkg-config
                # browser-secret helper links against the host's libsecret.
                libsecret
                imagemagick
              ]
              ++ lib.optionals stdenv.hostPlatform.isDarwin [
                # clang toolchain for node-gyp on macOS.
                clang
              ];

            # The Vite+ CLI (`vp`) is not packaged in nixpkgs. Install it once:
            #   curl -fsSL https://vite.plus | bash
            # with VP_NODE_MANAGER=no so it reuses this shell's Node.
            shellHook = ''
              if ! command -v vp >/dev/null 2>&1; then
                echo "note: 'vp' not found. Install it with:" >&2
                echo "  curl -fsSL https://vite.plus | VP_NODE_MANAGER=no bash" >&2
              fi
            '';
          };
        }
      );
    };
}
