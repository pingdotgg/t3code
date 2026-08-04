{
  cacert,
  fetchPnpmDeps,
  lib,
  makeBinaryWrapper,
  node-gyp,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  python3,
  rustPlatform,
  src,
  stdenv,
  version ? null,
  writableTmpDirAsHomeHook,
}:

let
  nodejs = nodejs_24;
  pnpm = pnpm_11;
  sourceVersion = (builtins.fromJSON (builtins.readFile "${src}/apps/server/package.json")).version;
  resourceMonitor = rustPlatform.buildRustPackage {
    pname = "t3-resource-monitor";
    version =
      (builtins.fromTOML (builtins.readFile "${src}/native/resource-monitor/Cargo.toml")).package.version;
    src = "${src}/native/resource-monitor";
    cargoLock.lockFile = "${src}/native/resource-monitor/Cargo.lock";
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "t3code";
  version = if version == null then sourceVersion else version;
  inherit src;
  strictDeps = true;

  pnpmWorkspaces = [
    "@t3tools/monorepo"
    "t3..."
    "@t3tools/web..."
    "@t3tools/scripts..."
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-LJ/s/fzzaW4UZFNmJOLnoWYs9c2+yNB1VKvKnW+mWGw=";
  };

  postPatch = lib.optionalString (finalAttrs.version != sourceVersion) ''
    substituteInPlace \
      apps/desktop/package.json \
      apps/server/package.json \
      apps/web/package.json \
      packages/contracts/package.json \
      --replace-fail '"version": "${sourceVersion}"' \
      '"version": "${finalAttrs.version}"'
  '';

  nativeBuildInputs = [
    makeBinaryWrapper
    node-gyp
    nodejs
    pnpm
    pnpmConfigHook
    python3
    writableTmpDirAsHomeHook
  ];

  dontPatchELF = true;
  noAuditTmpdir = true;
  SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";

  preBuild = ''
    export npm_config_nodedir=${nodejs}
    export ELECTRON_SKIP_BINARY_DOWNLOAD=1
    pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'
  '';

  buildPhase = ''
    runHook preBuild

    pnpm --filter @t3tools/web build
    pnpm --filter t3 build:bundle

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir --parents "$out"/libexec/t3code/apps/server
    cp --recursive --no-preserve=mode node_modules "$out"/libexec/t3code
    cp --recursive --no-preserve=mode packages "$out"/libexec/t3code
    cp --recursive --no-preserve=mode apps/server/{node_modules,dist} "$out"/libexec/t3code/apps/server
    cp --recursive --no-preserve=mode apps/web/dist "$out"/libexec/t3code/apps/server/dist/client
    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor \
      "$out"/libexec/t3code/apps/server/dist/resource-monitor/linux-x64/t3-resource-monitor

    find "$out"/libexec/t3code -xtype l -delete

    makeWrapper ${lib.getExe nodejs} "$out"/bin/t3 \
      --add-flags "$out"/libexec/t3code/apps/server/dist/bin.mjs

    runHook postInstall
  '';

  meta = {
    description = "Remote control for coding agents";
    homepage = "https://github.com/tarik02-org/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = [ "x86_64-linux" ];
  };
})
