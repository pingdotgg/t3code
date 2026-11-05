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
        extraPkgs = pkgs: [ pkgs.git ];
        profile = "export T3CODE_DISABLE_AUTO_UPDATE=true";
        nativeBuildInputs = [ pkgs.makeWrapper ];
        extraInstallCommands = ''
          mount=$out/libexec/t3code/mount
          mkdir -p $mount
          ln -s ${contents}/resources $mount/resources
          ln -s $out/bin/${pname} $mount/${pname}
          cat > $out/libexec/t3code/appimage <<EOF
          #!${pkgs.runtimeShell}
          echo $mount
          exec ${pkgs.coreutils}/bin/sleep infinity
          EOF
          chmod +x $out/libexec/t3code/appimage
          wrapProgram $out/bin/${pname} \
            --set APPIMAGE $out/libexec/t3code/appimage \
            --set T3CODE_DESKTOP_LAUNCHER_PATH $out/bin/${pname}
          makeWrapper $out/bin/${pname} $out/bin/t3 \
            --set ELECTRON_RUN_AS_NODE 1 \
            --set T3CODE_CLI_PATH $out/bin/t3 \
            --add-flags ${contents}/resources/app.asar/apps/server/dist/bin.mjs
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
