{
  description = "T3 Code - A harness for coding agents";

  # ===== MAINTENANCE NOTES FOR MAINTAINERS =====
  #
  #   let
  #     releaseTag = "v0.0.24";
  #     version = lib.removePrefix "v" releaseTag;
  #     appimageHash = "sha256-t8KYAtaQKWmCVOOwvHByosYoqb0Ji35Qe4m+8Gtp/+k=";
  #   in
  #   {
  #     . . .
  #   };
  #
  # To update to a new release:
  #   1. Update `releaseTag` to the new version (e.g., "v0.0.25")
  #   2. Update `appimageHash`:
  #       nix-prefetch-url https://github.com/pingdotgg/t3code/releases/download/v0.0.25/T3-Code-0.0.25-x86_64.AppImage
  # ==============================================

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;

      releaseTag = "v0.0.24";
      version = lib.removePrefix "v" releaseTag;
      appimageHash = "sha256-t8KYAtaQKWmCVOOwvHByosYoqb0Ji35Qe4m+8Gtp/+k=";

      supportedSystems = [ "x86_64-linux" ];

      pkgs = import nixpkgs { system = "x86_64-linux"; };

      appimage = pkgs.fetchurl {
        url = "https://github.com/pingdotgg/t3code/releases/download/${releaseTag}/T3-Code-${version}-x86_64.AppImage";
        sha256 = appimageHash;
      };
    in
    {
      packages.x86_64-linux = {
        default = pkgs.stdenv.mkDerivation {
          pname = "t3code";
          inherit version;

          src = appimage;

          dontStrip = true;
          dontUnpack = true;

          installPhase = ''
            mkdir -p $out/bin
            cp $src $out/bin/t3code.AppImage
            chmod +x $out/bin/t3code.AppImage

            cat > $out/bin/t3code << 'LAUNCHER'
            #!/bin/sh
            exec appimage-run "$(dirname "$0")/t3code.AppImage" "$@"
            LAUNCHER
            chmod +x $out/bin/t3code
          '';

          meta = {
            description = "T3 Code - A harness for coding agents";
            homepage = "https://t3.codes";
            license = lib.licenses.mit;
            platforms = supportedSystems;
          };
        };
      };
    };
}
