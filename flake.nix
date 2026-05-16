{
  description = "T3 Code - A harness for coding agents";

  inputs = {
    # Pinned to stable to avoid breaking changes
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
    
    # Track upstream repo - run `nix flake update` to check for changes
    t3code-src = {
      url = "github:pingdotgg/t3code";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, t3code-src }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        
        # Get version from upstream commit
        version = t3code-src.shortRev or "latest";
      in
      {
        packages.default =
          pkgs.stdenv.mkDerivation {
            pname = "t3code";
            inherit version;

            src = t3code-src;

            # Build dependencies
            nativeBuildInputs = with pkgs; [
              bun
              nodejs
              git
            ];

            # Allow network for bun to fetch dependencies
            allowNetworking = true;
            
            configurePhase = ''
              # Install dependencies
              bun install
            '';

            buildPhase = ''
              # Build the desktop app
              bun run build:desktop
            '';

            installPhase = ''
              mkdir -p $out/bin
              
              # Find and copy the built AppImage
              APPIMAGE=$(find . -path "*/dist/*" -name "*.AppImage" -type f 2>/dev/null | head -1)
              if [ -n "$APPIMAGE" ]; then
                cp "$APPIMAGE" "$out/t3code.AppImage"
                chmod +x "$out/t3code.AppImage"
                
                # Create a wrapper script in $out/bin for PATH access
                cat > $out/bin/t3code << 'WRAPPER'
#!/bin/sh
exec "$(dirname "$0")/../t3code.AppImage" "$@"
WRAPPER
                chmod +x $out/bin/t3code
              else
                # Fallback: check other common locations
                APPIMAGE=$(find . -name "*.AppImage" -type f 2>/dev/null | head -1)
                if [ -n "$APPIMAGE" ]; then
                  cp "$APPIMAGE" "$out/t3code.AppImage"
                  chmod +x "$out/t3code.AppImage"
                  
                  cat > $out/bin/t3code << 'WRAPPER'
#!/bin/sh
exec "$(dirname "$0")/../t3code.AppImage" "$@"
WRAPPER
                  chmod +x $out/bin/t3code
                else
                  echo "ERROR: No AppImage found in build output" >&2
                  exit 1
                fi
              fi
            '';

            meta = {
              description = "T3 Code - A harness for coding agents";
              homepage = "https://t3.codes";
              license = pkgs.lib.licenses.mit;
              platforms = [ "x86_64-linux" "aarch64-linux" ];
            };
          };
      }
    );
}