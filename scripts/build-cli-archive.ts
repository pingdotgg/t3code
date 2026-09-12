#!/usr/bin/env node
/**
 * Packages the server single-executable into a self-contained per-platform
 * archive: the `t3` binary, the web client, the resource monitor, and a
 * production install of the native packages the bundle keeps external. The
 * archive is the unit every runtime installer downloads, so nothing in it may
 * require Node, npm, or a compiler on the machine that unpacks it.
 *
 * Layout inside the archive (a single top-level directory named after the
 * archive stem):
 *
 *   t3 | t3.exe          the single-executable
 *   client/              web app served by the server
 *   resource-monitor/    per-platform Rust helper, same paths as the npm package
 *   node_modules/        runtime externals (node-pty, msgpackr-extract, fff)
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64"]);
type BuildPlatform = typeof BuildPlatform.Type;
type BuildArch = typeof BuildArch.Type;

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export class CliArchiveCommandFailedError extends Schema.TaggedError<CliArchiveCommandFailedError>()(
  "CliArchiveCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class CliArchiveInputMissingError extends Schema.TaggedError<CliArchiveInputMissingError>()(
  "CliArchiveInputMissingError",
  { inputPath: Schema.String, hint: Schema.String },
) {
  override get message(): string {
    return `Missing ${this.inputPath}. ${this.hint}`;
  }
}

/** Platform/arch pair as it appears in archive names and `process.platform`/`process.arch`. */
export function cliArchivePlatformKey(platform: BuildPlatform, arch: BuildArch): string {
  const nodePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${nodePlatform}-${arch}`;
}

export function cliArchiveStem(version: string, platform: BuildPlatform, arch: BuildArch): string {
  return `t3-${version}-${cliArchivePlatformKey(platform, arch)}`;
}

export function cliArchiveFileName(version: string, platform: BuildPlatform, arch: BuildArch) {
  // gzip rather than xz: GNU tar needs an external xz binary for -J, which
  // minimal hosts lack, while every tar (and Node's zlib) handles gzip alone.
  return `${cliArchiveStem(version, platform, arch)}.${platform === "win" ? "zip" : "tar.gz"}`;
}

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Output is inherited so the build log shows what each tool did; a failing
  // signing or packaging step is otherwise a bare exit code.
  const child = yield* spawner.spawn(
    ChildProcess.isStandardCommand(command)
      ? ChildProcess.make(command.command, command.args, {
          ...command.options,
          stdout: "inherit",
          stderr: "inherit",
        })
      : command,
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new CliArchiveCommandFailedError({ command: label, exitCode });
  }
});

const requireInput = Effect.fn("requireInput")(function* (inputPath: string, hint: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(inputPath))) {
    return yield* new CliArchiveInputMissingError({ inputPath, hint });
  }
});

/**
 * Installs the runtime-external packages into `stageDir/node_modules` with a
 * hoisted, symlink-free layout. The tree is archived and unpacked on machines
 * without pnpm, so the store layout cannot be relied on to survive the trip.
 */
const stageRuntimeExternals = Effect.fn("stageRuntimeExternals")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* decodeWorkspaceConfig(
    yield* fs.readFileString(path.join(input.repoRoot, "pnpm-workspace.yaml")),
  );
  const catalog = workspace.catalog ?? {};
  const serverDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    catalog,
    "apps/server",
  );
  const fffNodeVersion = serverDependencies["@ff-labs/fff-node"];
  if (fffNodeVersion === undefined) {
    return yield* new CliArchiveInputMissingError({
      inputPath: "apps/server/package.json#dependencies['@ff-labs/fff-node']",
      hint: "The archive stages fff's platform binary from this version.",
    });
  }
  const dependencies = {
    ...selectCliRuntimeExternalDependencies(serverDependencies),
    ...resolveFffNativeDependencies(input.platform, input.arch, fffNodeVersion),
  };
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );

  yield* fs.writeFileString(
    path.join(input.stageDir, "package.json"),
    `${yield* encodeJsonString({
      name: "t3-runtime",
      version: input.version,
      private: true,
      packageManager: rootPackageJson.packageManager,
      dependencies,
    })}\n`,
  );
  yield* fs.writeFileString(
    path.join(input.stageDir, "pnpm-workspace.yaml"),
    yield* encodeStageWorkspaceConfig({
      ...createStageWorkspaceConfig({
        platform: input.platform,
        arch: input.arch,
        ...(workspace.allowBuilds ? { allowBuilds: workspace.allowBuilds } : {}),
        patchedDependencies,
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
      }),
      nodeLinker: "hoisted",
    }),
  );
  if (Object.keys(patchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(input.stageDir, "patches"));
  }

  const install = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(install.command, install.args, {
      cwd: input.stageDir,
      shell: install.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
    "vp install --prod (cli archive runtime externals)",
  );

  // pnpm's bookkeeping and the manifest only matter to pnpm; the runtime
  // resolves packages by directory. node-pty ships every platform's prebuilds
  // in one package (58 MB); only the archive's own platform loads.
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  const prebuildsDir = path.join(input.stageDir, "node_modules/node-pty/prebuilds");
  const foreignPrebuilds = (yield* fs
    .readDirectory(prebuildsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter(
    (entry) => entry !== platformKey,
  );
  for (const entry of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
    ...foreignPrebuilds.map((entry) => `node_modules/node-pty/prebuilds/${entry}`),
  ]) {
    yield* fs.remove(path.join(input.stageDir, entry), { recursive: true, force: true });
  }
});

/** Copies the web client without its sourcemaps, which nothing serves. */
const stageWebClient = Effect.fn("stageWebClient")(function* (source: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.copy(source, target);
  const maps = (yield* fs.readDirectory(target, { recursive: true })).filter((entry) =>
    entry.endsWith(".map"),
  );
  for (const entry of maps) {
    yield* fs.remove(path.join(target, entry), { force: true });
  }
});

const MacSigningConfig = Config.all({
  identity: Config.string("T3CODE_CLI_MAC_SIGN_IDENTITY").pipe(Config.option),
  appleApiKey: Config.string("APPLE_API_KEY").pipe(Config.option),
  appleApiKeyId: Config.string("APPLE_API_KEY_ID").pipe(Config.option),
  appleApiIssuer: Config.string("APPLE_API_ISSUER").pipe(Config.option),
});

/**
 * Apple Silicon refuses to run unsigned Mach-O binaries at all, so the
 * executable is always signed: ad hoc when no identity is configured, or with
 * the Developer ID plus notarization when it is. The hardened runtime that
 * notarization requires only loads signed libraries, so every native addon in
 * the archive is signed with the same identity.
 */
const signMacArchiveContents = Effect.fn("signMacArchiveContents")(function* (input: {
  readonly repoRoot: string;
  readonly contentDir: string;
  readonly executablePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const signing = yield* MacSigningConfig;
  const identity = Option.getOrUndefined(signing.identity)?.trim() || "-";

  const entitlements = path.join(input.repoRoot, "apps/server/resources/cli-entitlements.plist");
  const libraries = (yield* fs.readDirectory(input.contentDir, { recursive: true }))
    .filter(
      (entry) =>
        entry.endsWith(".node") ||
        entry.endsWith(".dylib") ||
        entry.endsWith("spawn-helper") ||
        entry.endsWith("t3-resource-monitor"),
    )
    .map((entry) => path.join(input.contentDir, entry));

  for (const target of [...libraries, input.executablePath]) {
    yield* runCommand(
      ChildProcess.make("codesign", [
        "--force",
        "--sign",
        identity,
        ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
        ...(target === input.executablePath ? ["--entitlements", entitlements] : []),
        target,
      ]),
      `codesign ${path.relative(input.contentDir, target)}`,
    );
  }
  if (identity === "-") {
    yield* Effect.log("[cli-archive] Signed ad hoc (no T3CODE_CLI_MAC_SIGN_IDENTITY).");
    return;
  }

  const apiKey = Option.getOrUndefined(signing.appleApiKey);
  const apiKeyId = Option.getOrUndefined(signing.appleApiKeyId);
  const apiIssuer = Option.getOrUndefined(signing.appleApiIssuer);
  if (!apiKey || !apiKeyId || !apiIssuer) {
    yield* Effect.logWarning(
      "[cli-archive] Developer ID signed but not notarized (missing APPLE_API_KEY*).",
    );
    return;
  }
  // notarytool only accepts archives, and a bare executable cannot be stapled,
  // so notarize a zip of the binary and rely on the online ticket lookup.
  const notarizeZip = path.join(path.dirname(input.executablePath), ".notarize-t3.zip");
  yield* runCommand(
    ChildProcess.make("ditto", ["-c", "-k", "--keepParent", input.executablePath, notarizeZip]),
    "ditto (notarization zip)",
  );
  yield* runCommand(
    ChildProcess.make("xcrun", [
      "notarytool",
      "submit",
      notarizeZip,
      "--key",
      apiKey,
      "--key-id",
      apiKeyId,
      "--issuer",
      apiIssuer,
      "--wait",
    ]),
    "notarytool submit",
  ).pipe(Effect.ensuring(fs.remove(notarizeZip, { force: true }).pipe(Effect.ignore)));
  yield* Effect.log("[cli-archive] Notarized t3.");
});

const WindowsSigningConfig = Config.all({
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT").pipe(Config.option),
  accountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME").pipe(Config.option),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME").pipe(
    Config.option,
  ),
});

/** Signs t3.exe through the same Azure Trusted Signing setup the installer uses. */
const signWindowsExecutable = Effect.fn("signWindowsExecutable")(function* (
  executablePath: string,
) {
  const signing = yield* WindowsSigningConfig;
  const endpoint = Option.getOrUndefined(signing.endpoint);
  const accountName = Option.getOrUndefined(signing.accountName);
  const profile = Option.getOrUndefined(signing.certificateProfileName);
  if (!endpoint || !accountName || !profile) {
    yield* Effect.log("[cli-archive] Windows signing disabled (missing Azure Trusted Signing).");
    return;
  }
  // Node's --build-sea injects the blob into a copy of node.exe by rebuilding
  // its resource section, but unlike its Mach-O path it leaves the original
  // Authenticode entry in place. The certificate table then points at bytes
  // that moved, and signtool refuses the image with 0x800700C1 ("not a valid
  // Win32 application") until that stale signature is removed. The Trusted
  // Signing module ships a Windows SDK signtool; `signtool remove /s` strips
  // the security directory so the fresh signature lands on a clean PE.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const stripScript = [
    "$ErrorActionPreference = 'Stop';",
    "$signtool = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'TrustedSigning') -Recurse -Filter signtool.exe |",
    "  Where-Object { $_.FullName -match '\\\\x64\\\\signtool\\.exe$' } | Select-Object -First 1 -ExpandProperty FullName;",
    "if (-not $signtool) { $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source };",
    "if (-not $signtool) { throw 'signtool.exe not found; run the Trusted Signing preparation step first.' };",
    `& $signtool remove /s ${quote(executablePath)};`,
    'if ($LASTEXITCODE -ne 0) { throw "signtool remove failed with exit code $LASTEXITCODE" }',
  ].join(" ");
  yield* runCommand(
    ChildProcess.make("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stripScript]),
    "signtool remove t3.exe",
  );
  // Mirrors electron-builder's invocation for the installer: every value
  // single-quoted, the file path in Windows form. `$ErrorActionPreference`
  // makes a signing failure inside the cmdlet surface as a non-zero exit.
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "Invoke-TrustedSigning",
    `-Endpoint ${quote(endpoint)}`,
    `-CodeSigningAccountName ${quote(accountName)}`,
    `-CertificateProfileName ${quote(profile)}`,
    "-FileDigest 'SHA256'",
    "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
    "-TimestampDigest 'SHA256'",
    `-Files ${quote(executablePath)}`,
  ].join(" ");
  yield* runCommand(
    ChildProcess.make("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]),
    "Invoke-TrustedSigning t3.exe",
  );
  yield* Effect.log("[cli-archive] Signed t3.exe (Azure Trusted Signing).");
});

const buildCliArchive = Effect.fn("buildCliArchive")(function* (input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly resourceMonitorDir: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const executableName = input.platform === "win" ? "t3.exe" : "t3";
  // tsdown suffixes cross-built executables with their target (t3-darwin-x64);
  // a host build is plain t3. Prefer the exact target when both exist.
  const targetKey = `${input.platform === "mac" ? "darwin" : input.platform}-${input.arch}`;
  const targetExecutable = path.join(
    serverDir,
    "dist-exe",
    `t3-${targetKey}${input.platform === "win" ? ".exe" : ""}`,
  );
  // The unsuffixed host build is only a valid stand-in when it was built for
  // this platform and architecture; otherwise a missing target must fail.
  const hostPlatform = yield* HostProcessPlatform;
  const hostKey = `${hostPlatform === "win32" ? "win" : hostPlatform}-${yield* HostProcessArchitecture}`;
  const builtExecutable = (yield* fs.exists(targetExecutable))
    ? targetExecutable
    : targetKey === hostKey
      ? path.join(serverDir, "dist-exe", executableName)
      : targetExecutable;
  const webClient = path.join(serverDir, "dist/client");
  const resourceMonitorDir = Option.getOrElse(input.resourceMonitorDir, () =>
    path.join(serverDir, "dist/resource-monitor"),
  );

  yield* requireInput(
    builtExecutable,
    `Run \`node apps/server/scripts/cli.ts build-exe --target ${targetKey}\` first.`,
  );
  yield* requireInput(path.join(webClient, "index.html"), "Run `vp run --filter t3 build` first.");
  yield* requireInput(
    resourceMonitorDir,
    "Build the resource monitor or pass --resource-monitor-dir.",
  );

  const stem = cliArchiveStem(input.version, input.platform, input.arch);
  const stageRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-archive-" });
  const contentDir = path.join(stageRoot, stem);
  yield* fs.makeDirectory(contentDir, { recursive: true });

  yield* Effect.log(`[cli-archive] Staging ${stem}...`);
  yield* fs.copyFile(builtExecutable, path.join(contentDir, executableName));
  yield* stageWebClient(webClient, path.join(contentDir, "client"));
  yield* fs.copy(resourceMonitorDir, path.join(contentDir, "resource-monitor"));
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: contentDir,
    platform: input.platform,
    arch: input.arch,
    version: input.version,
  });

  const executablePath = path.join(contentDir, executableName);
  if (input.platform === "mac") {
    yield* signMacArchiveContents({ repoRoot, contentDir, executablePath });
  } else if (input.platform === "win") {
    yield* signWindowsExecutable(executablePath);
  }
  if (input.platform !== "win") {
    yield* fs.chmod(executablePath, 0o755);
  }

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const archivePath = path.join(
    input.outputDir,
    cliArchiveFileName(input.version, input.platform, input.arch),
  );
  yield* fs.remove(archivePath, { force: true });
  if (input.platform === "win") {
    // bsdtar ships with Windows 10+ and writes zip natively.
    yield* runCommand(
      ChildProcess.make("tar", ["-a", "-c", "-f", archivePath, "-C", stageRoot, stem]),
      "tar (zip)",
    );
  } else {
    yield* runCommand(
      ChildProcess.make("tar", ["-czf", archivePath, "-C", stageRoot, stem]),
      "tar (gzip)",
    );
  }
  const stat = yield* fs.stat(archivePath);
  yield* Effect.log(`[cli-archive] Wrote ${archivePath} (${String(stat.size)} bytes).`);
  return archivePath;
});

const command = Command.make(
  "build-cli-archive",
  {
    platform: Flag.choice("platform", BuildPlatform.literals),
    arch: Flag.choice("arch", BuildArch.literals),
    version: Flag.string("version").pipe(
      Flag.withDescription("Release version for the archive name."),
    ),
    outputDir: Flag.string("output-dir").pipe(Flag.withDefault("release-cli")),
    resourceMonitorDir: Flag.string("resource-monitor-dir").pipe(
      Flag.withDescription(
        "Directory laid out like dist/resource-monitor (defaults to apps/server/dist/resource-monitor).",
      ),
      Flag.optional,
    ),
  },
  (input) => buildCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Package the t3 single-executable into a per-platform archive."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
