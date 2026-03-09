{
  description = "Linux development shell for T3 Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    bun = {
      url = "github:s3bba/bun_overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, bun, nixpkgs, ... }:
    let
      devSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      packageSystems = [ "x86_64-linux" ];
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          overlays = [ bun.overlays.default ];
        };
      forEachDevSystem = nixpkgs.lib.genAttrs devSystems;
      forEachPackageSystem = nixpkgs.lib.genAttrs packageSystems;
      commitHash =
        if self ? shortRev then
          self.shortRev
        else if self ? rev then
          builtins.substring 0 12 self.rev
        else
          null;
      rev = if commitHash != null then commitHash else "dirty";
    in
    {
      devShells = forEachDevSystem (
        system:
        let
          pkgs = pkgsFor system;
          nativeRuntimeLibraries = with pkgs; [
            stdenv.cc.cc.lib
            zlib
          ];
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs_24
              pkgs.electron_40
              pkgs.git
              pkgs.xdg-utils
              pkgs.pkg-config
              pkgs.python3
              pkgs.gnumake
              pkgs.gcc
            ];

            buildInputs = nativeRuntimeLibraries;

            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath nativeRuntimeLibraries;

            # Use nixpkgs Electron instead of the npm-downloaded binary so desktop
            # development works on Linux without depending on an FHS userspace.
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_40}/bin";

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              echo "T3 Code Linux dev shell ready. Run: bun install"
              echo "Codex CLI still needs to be installed separately."
            '';
          };
        }
      );

      packages = forEachPackageSystem (
        system:
        let
          pkgs = pkgsFor system;
          node_modules = pkgs.callPackage ./nix/node-modules.nix {
            inherit rev;
          };
          t3code = pkgs.callPackage ./nix/t3chat.nix {
            inherit node_modules commitHash;
          };
        in
        {
          default = t3code;
          desktop = t3code;
          t3code = t3code;
          t3chat = t3code;
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );

      formatter = forEachDevSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt-rfc-style
      );
    };
}
