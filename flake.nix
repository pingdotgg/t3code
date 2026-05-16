{
  description = "T3 Code - A harness for coding agents";

  inputs = {
    # Pinned to stable to avoid breaking changes
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    
    # Track upstream repo - run `nix flake update` to check for changes
    t3code-src = {
      url = "github:pingdotgg/t3code";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, t3code-src }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" ];
    in
    {
      packages = builtins.listToAttrs (
        map (system:
          let
            pkgs = import nixpkgs { inherit system; };
            
            # Get version from upstream commit
            version = t3code-src.shortRev or "latest";
            
            t3codePkg = pkgs.stdenv.mkDerivation {
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
                mkdir -p $out
                
                # Find the built AppImage
                APPIMAGE=$(find . -path "*/dist/*" -name "*.AppImage" -type f 2>/dev/null | head -1)
                if [ -z "$APPIMAGE" ]; then
                  APPIMAGE=$(find . -name "*.AppImage" -type f 2>/dev/null | head -1)
                fi
                
                if [ -n "$APPIMAGE" ]; then
                  cp "$APPIMAGE" "$out/t3code"
                  chmod +x "$out/t3code"
                else
                  echo "ERROR: No AppImage found in build output" >&2
                  exit 1
                fi
              '';

              meta = {
                description = "T3 Code - A harness for coding agents";
                homepage = "https://t3.codes";
                license = pkgs.lib.licenses.mit;
                platforms = [ "x86_64-linux" "aarch64-linux" ];
              };
            };
          in
          lib.nameValuePair system t3codePkg
        ) systems
      );
    };
}