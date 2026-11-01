{
  description = "T3 Code desktop package for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      release = builtins.fromJSON (builtins.readFile ./packaging/nix/release.json);
      pname = "t3code";
      inherit (release) version;
      src = pkgs.fetchurl {
        url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/T3-Code-${version}-x86_64.AppImage";
        sha256 = release.sha256;
      };
      contents = pkgs.appimageTools.extract { inherit pname version src; };
      desktopItem = pkgs.makeDesktopItem {
        name = pname;
        desktopName = "T3 Code";
        comment = "Desktop control surface for local coding agents";
        exec = "${pname} %U";
        icon = pname;
        terminal = false;
        categories = [ "Development" ];
        mimeTypes = [ "x-scheme-handler/t3code" ];
        startupWMClass = "t3code";
      };
      t3code = pkgs.appimageTools.wrapType2 {
        inherit pname version src;
        profile = "export T3CODE_DISABLE_AUTO_UPDATE=true";
        nativeBuildInputs = [ pkgs.makeWrapper ];
        extraInstallCommands = ''
          wrapProgram $out/bin/${pname} --set APPIMAGE $out/bin/${pname}
          install -Dm644 ${desktopItem}/share/applications/${pname}.desktop \
            $out/share/applications/${pname}.desktop
          for icon in ${contents}/usr/share/icons/hicolor/*/apps/t3code.png; do
            size_dir="$(basename "$(dirname "$(dirname "$icon")")")"
            install -Dm644 "$icon" "$out/share/icons/hicolor/$size_dir/apps/${pname}.png"
          done
        '';
        meta = {
          description = "T3 Code desktop application";
          homepage = "https://github.com/pingdotgg/t3code";
          license = pkgs.lib.licenses.mit;
          mainProgram = pname;
          platforms = [ system ];
        };
      };
      app = {
        type = "app";
        program = pkgs.lib.getExe t3code;
        meta = t3code.meta;
      };
    in
    {
      packages.${system} = {
        inherit t3code;
        default = t3code;
      };
      apps.${system} = {
        t3code = app;
        default = app;
      };
    };
}
