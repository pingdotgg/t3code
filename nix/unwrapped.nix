# SPDX-License-Identifier: MIT
# T3 Code built from a local checkout. This is the nixpkgs `t3code`
# `unwrapped.nix` derivation with one difference: `src` comes from our
# flake (`srcRoot`) instead of `fetchFromGitHub`, so the exact same
# package installs from this repository.
{
  cctools,
  copyDesktopItems,
  electron_44,
  installShellFiles,
  lib,
  libicns,
  libsecret,
  makeBinaryWrapper,
  makeDesktopItem,
  node-gyp,
  nodejs_26,
  pkg-config,
  python3,
  spdx-license-list-data,
  stdenv,
  writeDarwinBundle,
  xcbuild,
  fetchPnpmDeps,
  pnpm_12,
  pnpmConfigHook,
  pnpmBuildHook,
  cacert,
  # Provided by our flake: the checkout root and a version string.
  # The default keeps `nix build` working when somebody copies this file
  # out of the flake without wiring those arguments.
  srcRoot,
  flakeVersion ? "dev",
}:

stdenv.mkDerivation (
  finalAttrs:
  let
    appName = "T3 Code (Alpha)";
    electron = electron_44;
    # Upstream package.json requires Node.js 26; the nixpkgs default is still 24.
    nodejs = nodejs_26;
    pnpm = pnpm_12;
    desktopIcon =
      if stdenv.hostPlatform.isDarwin then
        "assets/prod/black-macos-1024.png"
      else
        "assets/prod/black-universal-1024.png";

  in
  {
    pname = "t3code-unwrapped";
    # Keep the checkout's own version (apps/*/packages/*/package.json) so the
    # app and `t3 --version` report the code that was actually built.
    # The release pipeline bumps those files anyway before tagging.
    version = flakeVersion;
    strictDeps = true;
    __structuredAttrs = true;

    src = lib.fileset.toSource {
      root = srcRoot;
      # The sandbox has no network, and the build only reads the monorepo
      # sources plus the vendored docs. Vendored references and build output
      # never reach the builder.
      fileset =
        let
          tracked = lib.fileset.difference (lib.fileset.gitTracked srcRoot) (lib.fileset.unions [
            (lib.fileset.fileFilter (file: file.hasExt "md") srcRoot)
            (srcRoot + /.repos)
            (lib.fileset.maybeMissing (srcRoot + /release))
          ]);
        in
        lib.fileset.difference tracked (lib.fileset.unions [
          (lib.fileset.maybeMissing (srcRoot + /apps/web/.playwright))
          (lib.fileset.maybeMissing (srcRoot + /apps/web/playwright-report))
        ]);
    };

    postPatch = ''
      substituteInPlace apps/web/vite.config.ts \
        --replace-fail 'const host = explicitHost || "localhost";' \
                       'const host = explicitHost || "127.0.0.1";'

      mkdir -p .generated/third-party-licenses/spdx/v3.28.0
      cp ${spdx-license-list-data.json}/json/details/*.json \
        .generated/third-party-licenses/spdx/v3.28.0
    '';

    nativeBuildInputs = [
      installShellFiles
      makeBinaryWrapper
      node-gyp
      nodejs
      python3
      pnpmConfigHook
      pnpmBuildHook
      pnpm
      cacert
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      copyDesktopItems
      pkg-config
    ]
    ++ lib.optionals stdenv.hostPlatform.isDarwin [
      cctools.libtool
      libicns
      writeDarwinBundle
      xcbuild
    ];

    buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ libsecret ];

    pnpmWorkspaces = [
      # `...` suffix is used to also include other workspace packages that are
      # directly or indirectly depended on by the listed packages, such as
      # `@t3tools/contracts` and `@t3tools/shared`.
      "@t3tools/monorepo"
      "t3..."
      "@t3tools/desktop..."
      "@t3tools/scripts..."
    ];

    pnpmDeps = fetchPnpmDeps {
      inherit pnpm;
      inherit (finalAttrs)
        pname
        src
        pnpmWorkspaces
        ;

      fetcherVersion = 5;
      # Refresh with `nix build .#t3code-unwrapped` and copy the
      # `got: sha256-…` from a hash-mismatch error whenever pnpm-lock.yaml changes.
      hash = "sha256-+dNJoQzAIAx8QFov2dW9eN/TVoTwdWQiPrw2xHfBeEU=";
    };

    preBuild = ''
      # pnpm otherwise detects the package version updates below as
      # dependency drift and runs another install, including lifecycle scripts.
      export pnpm_config_verify_deps_before_run=false

      pnpm vp cache clean

      export npm_config_nodedir=${nodejs}
      export ELECTRON_SKIP_BINARY_DOWNLOAD=1
      # Exclude the `@t3tools/monorepo` workspace from the pending rebuild since
      # `vp config` needs git
      pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'
    '';

    pnpmBuildScript = "build:desktop";

    postBuild = ''
      pnpm vp cache clean
    '';

    # Many dependencies vendors many prebuilt native artifacts for non-host
    # platforms, and some of those binaries are statically linked. Let fixup
    # handle wrappers, shebangs, and stripping, but skip patchelf on the
    # vendored tree.
    dontPatchELF = true;
    # The tmpdir audit hook also shells out to patchelf while scanning every
    # vendored ELF for leaked build paths. That produces spurious warnings on
    # some dependencies' static foreign-platform binaries.
    noAuditTmpdir = true;

    installPhase = ''
      runHook preInstall

      mkdir --parents "$out"/libexec/t3code/apps/desktop "$out"/libexec/t3code/apps/server
      cp --recursive --no-preserve=mode node_modules "$out"/libexec/t3code
      cp --recursive --no-preserve=mode apps/server/{node_modules,dist} "$out"/libexec/t3code/apps/server
      cp --recursive --no-preserve=mode \
        apps/desktop/{package.json,node_modules,dist-electron} \
        "$out"/libexec/t3code/apps/desktop

      mkdir --parents "$out"/libexec/t3code/apps/desktop/prod-resources
      install --mode=444 ${desktopIcon} \
        "$out"/libexec/t3code/apps/desktop/prod-resources/icon.png
    ''
    + lib.optionalString stdenv.hostPlatform.isLinux ''
      install -Dm755 \
        native/browser-secret/build/${stdenv.hostPlatform.node.arch}/t3-browser-secret \
        "$out"/libexec/t3code/apps/desktop/prod-resources/browser-secret/t3-browser-secret
    ''
    + ''

      find "$out"/libexec/t3code -xtype l -delete

      makeWrapper ${lib.getExe nodejs} "$out"/bin/t3 \
        --add-flags "$out"/libexec/t3code/apps/server/dist/bin.mjs

      makeWrapper ${lib.getExe electron} "$out"/bin/t3code-desktop \
        --add-flags "$out"/libexec/t3code/apps/desktop \
        --inherit-argv0
    ''
    + lib.optionalString stdenv.hostPlatform.isDarwin ''
      # node-pty tries to chmod this helper at runtime, but the Nix store is
      # immutable by then.
      find "$out"/libexec/t3code \
        -path '*/node-pty/prebuilds/darwin-*/spawn-helper' \
        -exec chmod 755 {} +

      mkdir --parents "$out/Applications/${appName}.app/Contents/"{MacOS,Resources}
      png2icns \
        "$out/Applications/${appName}.app/Contents/Resources/t3code.icns" \
        ${desktopIcon}

      # writeDarwinBundle is a shebangless bash script; run it explicitly via
      # stdenv.shell to avoid Darwin's intermittent ENOEXEC fallback issues.
      ${stdenv.shell} ${lib.getExe writeDarwinBundle} \
        "$out" "${appName}" t3code-desktop t3code
    ''
    + ''
      mkdir --parents \
        "$out"/share/icons/hicolor/{1024x1024,scalable}/apps
      install --mode=444 ${desktopIcon} \
        "$out"/share/icons/hicolor/1024x1024/apps/t3code.png
      install --mode=444 assets/prod/logo.svg \
        "$out"/share/icons/hicolor/scalable/apps/t3code.svg

      runHook postInstall
    '';

    postInstall = ''
      for shell in bash fish zsh; do
        installShellCompletion --cmd t3 --"$shell" <("$out"/bin/t3 --completions "$shell")
      done
    '';

    postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
      # Electron's Node runtime does not provide libstdc++ for the bundled node-pty prebuild
      for module in "$out"/libexec/t3code/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-${stdenv.hostPlatform.node.arch}/pty.node; do
        patchelf --add-rpath ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} "$module"
      done
    '';

    desktopItems = [
      (makeDesktopItem {
        name = "t3code";
        desktopName = appName;
        comment = "Minimal web GUI for coding agents";
        exec = "t3code-desktop %U";
        terminal = false;
        icon = "t3code";
        startupWMClass = "t3code";
        categories = [ "Development" ];
      })
    ];

    meta = {
      description = "Minimal web GUI for coding agents";
      homepage = "https://t3.codes";
      downloadPage = "https://t3.codes/download";
      license = lib.licenses.mit;
      maintainers = with lib.maintainers; [
        _0x4bs3nt
        iamanaws
        qweered
      ];
      mainProgram = "t3code-desktop";
      inherit (nodejs.meta) platforms;
    };
  }
)
