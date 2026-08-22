{
  buildCommit,
  pkgs,
  self,
}: let
  lib = pkgs.lib;
  desktopPackage = builtins.fromJSON (builtins.readFile ../apps/desktop/package.json);
  rootPackage = builtins.fromJSON (builtins.readFile ../package.json);
  appName = desktopPackage.productName;
  electron = pkgs.electron_41;
  nodejs = pkgs.nodejs_24;
  pnpm = pkgs.pnpm_11;
  # Client-only mode is supplied by its own topic/PR. Keep this flake
  # composable with that source without exposing a wrapper whose flag the
  # standalone upstream app would silently ignore.
  clientModeSupported =
    builtins.pathExists ../apps/desktop/src/app/DesktopBackendMode.ts;
  version =
    "${desktopPackage.version}-source"
    + lib.optionalString (buildCommit != "") "-${builtins.substring 0 8 buildCommit}";
  desktopIcon =
    if pkgs.stdenv.hostPlatform.isDarwin
    then ../assets/prod/black-macos-1024.png
    else ../assets/prod/black-universal-1024.png;

  unwrapped = pkgs.stdenv.mkDerivation (finalAttrs: {
    pname = "t3code-unwrapped";
    inherit version;

    src = self;
    strictDeps = true;
    __structuredAttrs = true;

    nativeBuildInputs =
      [
        pkgs.installShellFiles
        pkgs.makeBinaryWrapper
        pkgs.node-gyp
        nodejs
        pkgs.python3
        pkgs.pnpmConfigHook
        pnpm
        pkgs.cacert
      ]
      ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [
        pkgs.copyDesktopItems
      ]
      ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
        pkgs.cctools.libtool
        pkgs.libicns
        pkgs.xcbuild
      ];

    pnpmWorkspaces = [
      "@t3tools/monorepo"
      "t3..."
      "@t3tools/desktop..."
      "@t3tools/scripts..."
    ];

    pnpmDeps = pkgs.fetchPnpmDeps {
      inherit pnpm;
      inherit
        (finalAttrs)
        pname
        version
        src
        pnpmWorkspaces
        ;
      fetcherVersion = 4;
      # Fixed-output hash over the offline dependency closure. When
      # pnpm-lock.yaml changes, replace this with lib.fakeHash, build
      # .#unwrapped, and copy the reported hash here.
      hash = "sha256-2HeroptijgZF837wjMQXvHtXNTgd1OYE5TV1xfRHSgw=";
    };

    env.APP_VERSION = finalAttrs.version;

    postPatch = ''
      substituteInPlace package.json \
        --replace-fail '"packageManager": "${rootPackage.packageManager}"' \
                       '"packageManager": "pnpm@${pnpm.version}"'
      substituteInPlace pnpm-workspace.yaml \
        --replace-fail 'packages:' $'injectWorkspacePackages: true\n\npackages:'
      substituteInPlace pnpm-lock.yaml \
        --replace-fail '  excludeLinksFromLockfile: false' \
                       $'  excludeLinksFromLockfile: false\n  injectWorkspacePackages: true'
    '';

    preBuild = ''
      node scripts/update-release-package-versions.ts ${lib.escapeShellArg finalAttrs.version}

      export npm_config_nodedir=${nodejs}
      export ELECTRON_SKIP_BINARY_DOWNLOAD=1
      # `vp config` needs Git, so leave the root workspace out of the pending
      # native-module rebuild.
      pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'
    '';

    # Building through the root task discovers mobile and infrastructure
    # workspaces that are intentionally absent from pnpmWorkspaces. Build the
    # desktop dependency chain directly instead.
    buildPhase = ''
      runHook preBuild

      pushd apps/web
      ../../node_modules/.bin/vp build
      popd

      node apps/server/scripts/cli.ts build --verbose
      node apps/desktop/scripts/build-preview-annotation-css.mjs

      pushd apps/desktop
      ../../node_modules/.bin/vp pack
      popd

      runHook postBuild
    '';

    # Some dependencies vendor static binaries for non-host platforms.
    dontPatchELF = true;
    noAuditTmpdir = true;

    installPhase =
      ''
        runHook preInstall

        serverDeploy="$TMPDIR/t3code-server"
        desktopDeploy="$TMPDIR/t3code-desktop"
        pnpm --filter t3 deploy --prod --offline --frozen-lockfile \
          "$serverDeploy"
        pnpm --filter @t3tools/desktop deploy \
          --prod --offline --frozen-lockfile "$desktopDeploy"

        mkdir -p "$out"/libexec/t3code/apps
        cp -r --no-preserve=mode "$serverDeploy" \
          "$out"/libexec/t3code/apps/server
        cp -r --no-preserve=mode "$desktopDeploy" \
          "$out"/libexec/t3code/apps/desktop

        nodePtyPlatform="$(${lib.getExe nodejs} -p \
          '`''${process.platform}-''${process.arch}`')"
        while IFS= read -r nodePtyDir; do
          if [ -d "$nodePtyDir/build" ]; then
            find "$nodePtyDir/build" -mindepth 1 -maxdepth 1 \
              ! -name Release -exec rm -rf -- {} +
          fi
          if [ -d "$nodePtyDir/prebuilds" ]; then
            find "$nodePtyDir/prebuilds" -mindepth 1 -maxdepth 1 \
              -type d ! -name "$nodePtyPlatform" -exec rm -rf -- {} +
          fi
          rm -rf -- "$nodePtyDir/third_party/conpty"
        done < <(find "$out"/libexec/t3code/apps \
          -type d -path '*/node_modules/node-pty')

        mkdir -p "$out"/libexec/t3code/apps/desktop/prod-resources
        install -m444 ${desktopIcon} \
          "$out"/libexec/t3code/apps/desktop/prod-resources/icon.png

        # app.getAppPath() resolves to apps/desktop in this unpacked layout.
        mkdir -p "$out"/libexec/t3code/apps/desktop/apps/server/dist
        ln -s ../../../../server/dist/client \
          "$out"/libexec/t3code/apps/desktop/apps/server/dist/client

        find "$out"/libexec/t3code -xtype l -delete

        makeWrapper ${lib.getExe nodejs} "$out"/bin/t3 \
          --add-flags "$out"/libexec/t3code/apps/server/dist/bin.mjs
        makeWrapper ${lib.getExe electron} "$out"/bin/t3code-desktop \
          --add-flags "$out"/libexec/t3code/apps/desktop \
          --inherit-argv0
      ''
      + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        find "$out"/libexec/t3code \
          -path '*/node-pty/prebuilds/darwin-*/spawn-helper' \
          -exec chmod 755 {} +

        mkdir -p "$out/Applications/${appName}.app/Contents/"{MacOS,Resources}
        png2icns \
          "$out/Applications/${appName}.app/Contents/Resources/t3code.icns" \
          ${desktopIcon}
      ''
      + ''
        mkdir -p "$out"/share/icons/hicolor/scalable/apps
        install -m444 ${desktopIcon} "$out"/share/icons/t3code.png
        install -m444 assets/prod/logo.svg \
          "$out"/share/icons/hicolor/scalable/apps/t3code.svg

        runHook postInstall
      '';

    postInstall =
      lib.optionalString (
        pkgs.stdenv.buildPlatform.canExecute pkgs.stdenv.hostPlatform
      ) ''
        for shell in bash fish zsh; do
          installShellCompletion --cmd t3 --"$shell" <("$out/bin/t3" --completions "$shell")
        done
      '';

    desktopItems = [
      (pkgs.makeDesktopItem {
        name = "t3code";
        desktopName = appName;
        comment = "Minimal web GUI for coding agents";
        exec = "t3code-desktop %U";
        terminal = false;
        icon = "t3code";
        startupWMClass = "t3code";
        categories = ["Development"];
      })
    ];

    meta = {
      description = "Minimal web GUI for coding agents";
      homepage = "https://t3.codes";
      license = lib.licenses.mit;
      mainProgram = "t3code-desktop";
      inherit (nodejs.meta) platforms;
    };
  });

  runtimePackages = [
    pkgs.codex
    pkgs.gh
    pkgs.git
  ];

  t3code = pkgs.symlinkJoin {
    pname = "t3code";
    inherit (unwrapped) version;
    paths = [unwrapped];
    nativeBuildInputs = [pkgs.makeBinaryWrapper];
    postBuild =
      ''
        for program in "$out/bin"/*; do
          wrapProgram "$program" \
            --prefix PATH : "${lib.makeBinPath runtimePackages}"
        done
      ''
      + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        # Build the application launcher after wrapping so Finder follows the
        # same PATH and client-mode wrappers as direct command-line launches.
        mkdir -p "$out/Applications/${appName}.app/Contents/MacOS"
        ${pkgs.stdenv.shell} ${lib.getExe pkgs.writeDarwinBundle} \
          "$out" "${appName}" t3code-desktop t3code
      '';
    passthru = {inherit unwrapped;};
    inherit (unwrapped) meta;
  };

  client = t3code.overrideAttrs (previousAttrs: {
    pname = "t3code-client";
    buildCommand =
      previousAttrs.buildCommand
      + lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
        # Chromium does not recognize every Linux desktop as having a native
        # password store. Prefer Secret Service explicitly.
        mv "$out/bin/t3code-desktop" \
          "$out/bin/.t3code-desktop-client-unwrapped"
        makeWrapper "$out/bin/.t3code-desktop-client-unwrapped" \
          "$out/bin/t3code-desktop" \
          --add-flags "--password-store=gnome-libsecret" \
          --add-flags "--backend-mode=client-only"
      ''
      + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        mv "$out/bin/t3code-desktop" \
          "$out/bin/.t3code-desktop-client-unwrapped"
        makeWrapper "$out/bin/.t3code-desktop-client-unwrapped" \
          "$out/bin/t3code-desktop" \
          --add-flags "--backend-mode=client-only"
      '';
  });
in
  {
    inherit t3code unwrapped;
    default = t3code;
  }
  // lib.optionalAttrs clientModeSupported {
    inherit client;
  }
