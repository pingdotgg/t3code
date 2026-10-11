{
  description = "T3 Code desktop packages for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      releases = builtins.fromJSON (builtins.readFile ./packaging/nix/releases.json);
      mkPackage =
        channel:
        let
          release = releases.${channel};
          inherit (release) version;
          pname = if channel == "stable" then "t3code" else "t3code-nightly";
          src = pkgs.fetchurl {
            url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-x86_64.AppImage";
            sha256 = release.sha256;
          };
          contents = pkgs.appimageTools.extract { inherit pname version src; };
          desktopItem = pkgs.makeDesktopItem {
            name = pname;
            desktopName = if channel == "stable" then "T3 Code" else "T3 Code Nightly";
            comment = "Desktop control surface for local coding agents";
            exec = "${pname} %U";
            icon = pname;
            terminal = false;
            categories = [ "Development" ];
            mimeTypes = [ "x-scheme-handler/t3code" ];
            startupWMClass = "t3code";
          };
        in
        pkgs.appimageTools.wrapType2 {
          inherit pname version src;
          profile = "export T3CODE_DISABLE_AUTO_UPDATE=true";
          extraInstallCommands = ''
            install -Dm644 ${desktopItem}/share/applications/${pname}.desktop \
              $out/share/applications/${pname}.desktop
            for icon in ${contents}/usr/share/icons/hicolor/*/apps/t3code.png; do
              size_dir="$(basename "$(dirname "$(dirname "$icon")")")"
              install -Dm644 "$icon" "$out/share/icons/hicolor/$size_dir/apps/${pname}.png"
            done
          '';
          meta = {
            description = "T3 Code desktop application (${channel})";
            homepage = "https://github.com/pingdotgg/t3code";
            license = pkgs.lib.licenses.mit;
            mainProgram = pname;
            platforms = [ system ];
          };
        };
      stable = mkPackage "stable";
      nightly = mkPackage "nightly";
      mkApp = package: {
        type = "app";
        program = pkgs.lib.getExe package;
        meta = package.meta;
      };
    in
    {
      packages.${system} = {
        inherit stable nightly;
        default = stable;
        t3code = stable;
      };
      apps.${system} = {
        stable = mkApp stable;
        nightly = mkApp nightly;
        default = mkApp stable;
        t3code = mkApp stable;
      };
    };
}
