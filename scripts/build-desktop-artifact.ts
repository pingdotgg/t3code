#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Node's typed junction API avoids Windows symlink privileges while keeping the probe isolated.

import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import {
  CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS,
  findInlinedExternalPackages,
} from "./lib/cli-external-packages.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;
const DESKTOP_APP_ID = "com.t3tools.t3code";
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const decodeNodePtyManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

export function resolveResourceMonitorRustTargets(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (platform === "mac") {
    if (arch === "universal") {
      return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    }
    return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  }
  if (platform === "linux") {
    return [arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"];
  }
  return [arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"];
}

export function resourceMonitorExecutableName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
  readonly wslPrebuild: Option.Option<string>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

const getDefaultArch = Effect.fn("getDefaultArch")(function* (platform: typeof BuildPlatform.Type) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return yield* getDefaultBuildArch(platform, config);
});

export class MacPasskeySigningConfigurationResolutionError extends Schema.TaggedErrorClass<MacPasskeySigningConfigurationResolutionError>()(
  "MacPasskeySigningConfigurationResolutionError",
  {
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    cause: unknown,
  ): MacPasskeySigningConfigurationError | MacPasskeySigningConfigurationResolutionError {
    return isMacPasskeySigningConfigurationError(cause)
      ? cause
      : new MacPasskeySigningConfigurationResolutionError({ cause });
  }

  override get message(): string {
    return "Failed to resolve macOS passkey signing configuration.";
  }
}

export class ClerkPasskeyNativePackageMissingError extends Schema.TaggedErrorClass<ClerkPasskeyNativePackageMissingError>()(
  "ClerkPasskeyNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk passkey native package is missing: ${this.packageName}`;
  }
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedErrorClass<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedErrorClass<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: BuildArch,
    supportedArchitectures: Schema.Array(BuildArch),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

const InvalidMockUpdateServerPortReason = Schema.Literals([
  "not-numeric",
  "not-integer",
  "out-of-range",
]);

export class InvalidMockUpdateServerPortError extends Schema.TaggedErrorClass<InvalidMockUpdateServerPortError>()(
  "InvalidMockUpdateServerPortError",
  {
    reason: InvalidMockUpdateServerPortReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid mock update server port.";
  }

  static fromConfigValue(configuredPort: string, cause: unknown) {
    return new InvalidMockUpdateServerPortError({
      reason: invalidMockUpdateServerPortReason(configuredPort),
      inputLength: configuredPort.length,
      cause,
    });
  }
}

export class BuildCommandFailedError extends Schema.TaggedErrorClass<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedErrorClass<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

const desktopIconPlatformNames = {
  mac: "macOS",
  linux: "Linux",
  win: "Windows",
} satisfies Record<typeof BuildPlatform.Type, string>;

export class DesktopIconSourceMissingError extends Schema.TaggedErrorClass<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${desktopIconPlatformNames[this.platform]} icon source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedErrorClass<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class UnsupportedDesktopBuildPlatformError extends Schema.TaggedErrorClass<UnsupportedDesktopBuildPlatformError>()(
  "UnsupportedDesktopBuildPlatformError",
  {
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported platform '${this.platform}'.`;
  }
}

const dependencyResolutionDescriptions = {
  "server-production": "production dependencies",
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;
const DependencyResolutionKind = Schema.Literals([
  "server-production",
  "workspace-overrides",
  "desktop-runtime",
]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedErrorClass<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedErrorClass<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;
const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "server-dist": "serverDist",
  "bundled-server-client": "bundled server client",
} satisfies Record<DesktopBuildInputArtifact, string>;

/**
 * Imported by every server module, so it is inlined in any correctly bundled
 * build. Its absence means the bundle went back to externalizing its
 * dependencies, which the unpack globs do not cover.
 */
const BUNDLE_SELF_CONTAINED_SENTINEL = "effect";

const BUNDLE_SELF_CHECK_TIMEOUT = Duration.seconds(120);

export class ExternalizedBundleError extends Schema.TaggedErrorClass<ExternalizedBundleError>()(
  "ExternalizedBundleError",
  { sentinel: Schema.String, inlinedPackageCount: Schema.Number },
) {
  override get message(): string {
    return `The server bundle did not inline "${this.sentinel}" (${this.inlinedPackageCount} packages inlined). The bundle is meant to be self-contained apart from the native externals; if its dependencies are external again they will not be unpacked, and the WSL backend will fail with ERR_MODULE_NOT_FOUND. Check the deps.alwaysBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class BundleNotSelfContainedError extends Schema.TaggedErrorClass<BundleNotSelfContainedError>()(
  "BundleNotSelfContainedError",
  { exitCode: Schema.Number, output: Schema.String },
) {
  override get message(): string {
    return `The packaged server bundle could not load with only its unpacked dependencies present (exit ${this.exitCode}). Anything it imports that is neither a Node built-in nor an unpacked external is unreachable to the WSL backend, which runs plain node and cannot read app.asar. Output:
${this.output}`;
  }
}

export class InlinedNativePackageError extends Schema.TaggedErrorClass<InlinedNativePackageError>()(
  "InlinedNativePackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that load native binaries: ${this.packages.join(", ")}. A node-gyp-build style loader resolves prebuilds relative to its own file, so inlined into a chunk it finds none and the importer quietly falls back to a slower JS path. Add them to CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts so they stay external and get unpacked.`;
  }
}

export class InlinedExternalPackageError extends Schema.TaggedErrorClass<InlinedExternalPackageError>()(
  "InlinedExternalPackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that must stay external: ${this.packages.join(", ")}. These are native addons or their loaders; inlined, they resolve prebuilds relative to the bundle and silently lose native acceleration. Check the deps.neverBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedErrorClass<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedErrorClass<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedErrorClass<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedErrorClass<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

export class WslNodePtyPrebuildMissingError extends Schema.TaggedErrorClass<WslNodePtyPrebuildMissingError>()(
  "WslNodePtyPrebuildMissingError",
  {
    prebuildPath: Schema.String,
  },
) {
  override get message(): string {
    return `WSL node-pty prebuild not found at ${this.prebuildPath}.`;
  }
}

export class WslNodePtyManifestReadError extends Schema.TaggedErrorClass<WslNodePtyManifestReadError>()(
  "WslNodePtyManifestReadError",
  {
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read node-pty version from ${this.manifestPath}.`;
  }
}

export class LinuxIconResizeError extends Schema.TaggedErrorClass<LinuxIconResizeError>()(
  "LinuxIconResizeError",
  {
    operation: Schema.Literal("resize"),
    iconSize: Schema.Int,
    primaryTool: Schema.Literal("magick"),
    fallbackTool: Schema.Literal("convert"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the Linux desktop icon to ${this.iconSize}x${this.iconSize} with \`${this.primaryTool}\` or \`${this.fallbackTool}\`. Install ImageMagick so either tool is available.`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const env = yield* Config.all({
    configuredPython: Config.string("npm_config_python").pipe(
      Config.orElse(() => Config.string("PYTHON")),
      Config.option,
    ),
    localAppData: Config.string("LOCALAPPDATA").pipe(Config.option),
  });
  const configured = Option.getOrUndefined(env.configuredPython);
  if (configured && (yield* fs.exists(configured))) {
    return configured;
  }

  if (hostPlatform === "win32") {
    const localAppData = Option.getOrUndefined(env.localAppData);
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if (yield* fs.exists(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = yield* spawnAndCollectOutput(
    ChildProcess.make("python", ["-c", "import sys;print(sys.executable)"]),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (probe.exitCode !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !(yield* fs.exists(executable))) {
    return undefined;
  }

  return executable;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
  readonly wslPrebuild: string | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // T3 Code always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
] as const;
// The WSL backend launches the server with plain `wsl.exe -- node`, which cannot
// read inside an asar archive, so everything it loads must be on the real
// filesystem. This used to unpack `**\/node_modules\/**` wholesale, because the
// server bundle externalized its runtime deps and the Linux Node would fail with
// ERR_MODULE_NOT_FOUND ("Cannot find package 'effect'") before it even reached
// node-pty.
//
// The CLI bundle now inlines its JS dependencies, so the only things that still
// have to be loose are the server bundle itself and the packages the bundle
// leaves external — derived from the same list the bundler uses, so the two
// cannot drift apart.
export const WINDOWS_ASAR_UNPACK = [
  "apps/server/dist/**",
  ...CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS,
] as const;
export const DESKTOP_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
] as const;

export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedErrorClass<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedErrorClass<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `T3CODE_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

export class MissingMacPasskeyProvisioningProfileError extends Schema.TaggedErrorClass<MissingMacPasskeyProvisioningProfileError>()(
  "MissingMacPasskeyProvisioningProfileError",
  {},
) {
  override get message(): string {
    return "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.";
  }
}

export class MissingMacPasskeyDomainConfigurationError extends Schema.TaggedErrorClass<MissingMacPasskeyDomainConfigurationError>()(
  "MissingMacPasskeyDomainConfigurationError",
  {},
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY or T3CODE_CLERK_PASSKEY_RP_DOMAINS is required for signed macOS passkey builds.";
  }
}

export class InvalidMacPasskeyPublishableKeyError extends Schema.TaggedErrorClass<InvalidMacPasskeyPublishableKeyError>()(
  "InvalidMacPasskeyPublishableKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.";
  }
}

export class MissingMacPasskeyRpDomainError extends Schema.TaggedErrorClass<MissingMacPasskeyRpDomainError>()(
  "MissingMacPasskeyRpDomainError",
  {},
) {
  override get message(): string {
    return "At least one Clerk passkey RP domain is required.";
  }
}

export const MacPasskeySigningConfigurationError = Schema.Union([
  InvalidMacPasskeyRpDomainError,
  InvalidAppleTeamIdError,
  MissingMacPasskeyProvisioningProfileError,
  MissingMacPasskeyDomainConfigurationError,
  InvalidMacPasskeyPublishableKeyError,
  MissingMacPasskeyRpDomainError,
]);
export type MacPasskeySigningConfigurationError = typeof MacPasskeySigningConfigurationError.Type;
export const isMacPasskeySigningConfigurationError = Schema.is(MacPasskeySigningConfigurationError);

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): MacPasskeySigningConfiguration {
  const teamId = env.T3CODE_APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  const provisioningProfilePath = env.T3CODE_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  if (provisioningProfilePath.length === 0) {
    throw new MissingMacPasskeyProvisioningProfileError();
  }

  const configuredRpDomains = env.T3CODE_CLERK_PASSKEY_RP_DOMAINS?.trim();
  let rpDomains: readonly string[];
  if (configuredRpDomains) {
    rpDomains = configuredRpDomains.split(",").map(normalizePasskeyRpDomain);
  } else {
    const publishableKey = env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new MissingMacPasskeyDomainConfigurationError();
    }
    let hostname: string;
    try {
      hostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
    } catch (cause) {
      throw new InvalidMacPasskeyPublishableKeyError({ cause });
    }
    rpDomains = [normalizePasskeyRpDomain(hostname)];
  }

  const uniqueRpDomains = [...new Set(rpDomains)];
  if (uniqueRpDomains.length === 0) {
    throw new MissingMacPasskeyRpDomainError();
  }

  return {
    appId: DESKTOP_APP_ID,
    teamId,
    rpDomains: uniqueRpDomains,
    provisioningProfilePath,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
): string {
  const associatedDomains = configuration.rpDomains
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(`${configuration.teamId}.${configuration.appId}`)}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
`;
}

export function resolveFffNativeDependencies(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
      binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-win32-${architecture}-msvc`,
      binaryFileName: `electron-passkeys.win32-${architecture}-msvc.node`,
    }));
  }

  return [];
}

// pnpm nests the architecture package under @clerk/electron-passkeys, while electron-builder only
// retains collected top-level dependencies. The SDK loader checks beside index.js first, so stage
// the binary there and let electron-builder's native-addon handling unpack it from the ASAR.
const stageClerkPasskeyNativeBinaries = Effect.fn("stageClerkPasskeyNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@clerk", "electron-passkeys", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveClerkPasskeyNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(artifact.packageName),
      catch: (cause) =>
        new ClerkPasskeyNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  // Linux AppImages and Windows WSL backends both execute a Linux/glibc Node
  // process that loads Linux-native optional deps at runtime (e.g.
  // @yuuang/ffi-rs-linux-x64-gnu). Keep libc explicit so pnpm includes those
  // optional packages in the staged production install.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : platform === "win"
        ? {
            os: Array.from(new Set([hostOs, "linux"])),
            cpu: hostCpu,
            libc: ["glibc"],
          }
        : {
            os: [hostOs],
            cpu: hostCpu,
          };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  // Path to a prebuilt Linux node-pty binary (pty.node) for the target arch,
  // produced by the Linux CI job and handed to the Windows packaging job. Placed
  // into the staged node-pty so the WSL backend ships a ready binary and never
  // compiles on the user's machine.
  wslPrebuild: Config.string("T3CODE_DESKTOP_WSL_PREBUILD").pipe(Config.option),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

function invalidMockUpdateServerPortReason(
  configuredPort: string,
): typeof InvalidMockUpdateServerPortReason.Type {
  const parsed = Number(configuredPort);
  if (!Number.isFinite(parsed)) return "not-numeric";
  if (!Number.isInteger(parsed)) return "not-integer";
  if (parsed < 1 || parsed > 65535) return "out-of-range";
  // This mapper is only called after schema decoding failed. An otherwise
  // valid integer therefore used a representation the decoder did not accept.
  return "not-numeric";
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcessPlatform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(hostPlatform),
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const defaultArch = yield* getDefaultArch(platform);
  const arch = mergeOptions(input.arch, env.arch, defaultArch);
  const supportedArchitectures = PLATFORM_CONFIG[platform].archChoices;
  if (!supportedArchitectures.includes(arch)) {
    return yield* new UnsupportedDesktopBuildArchitectureError({
      platform,
      arch,
      supportedArchitectures: [...supportedArchitectures],
    });
  }
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const configuredMockUpdateServerPort = Option.getOrUndefined(env.mockUpdateServerPort);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (configuredMockUpdateServerPort === undefined
      ? undefined
      : yield* resolveMockUpdateServerPort(configuredMockUpdateServerPort).pipe(
          Effect.mapError((cause) =>
            InvalidMockUpdateServerPortError.fromConfigValue(configuredMockUpdateServerPort, cause),
          ),
        ));

  const wslPrebuild =
    Option.getOrUndefined(input.wslPrebuild) ?? Option.getOrUndefined(env.wslPrebuild);

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
    wslPrebuild,
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

/**
 * Every `node_modules` directory that would be visible from `startDir`.
 *
 * The self-containment check is only meaningful in a directory with none of
 * these: Node walks parents when resolving a bare import, so a stray
 * node_modules above the probe would satisfy imports that are missing from the
 * packaged tree and turn the check into a silent pass.
 */
function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

/**
 * Length of the `\\server\share` prefix, or 0 when the path is not UNC.
 *
 * The share is the highest real directory on a UNC path: `\\server` on its own
 * is not one, so the ancestor walk must stop there.
 */
function uncShareRootLength(value: string): number {
  const isUnc = value.startsWith("\\\\") || value.startsWith("//");
  if (!isUnc) return 0;
  const separator = /[\\/]/;
  const serverEnd = value.slice(2).search(separator);
  if (serverEnd < 0) return value.length;
  const shareStart = 2 + serverEnd + 1;
  const shareEnd = value.slice(shareStart).search(separator);
  return shareEnd < 0 ? value.length : shareStart + shareEnd;
}

export function ancestorNodeModulesPaths(
  startDir: string,
  separator: string,
): ReadonlyArray<string> {
  // Walks with lastIndexOf rather than splitting into segments so UNC roots
  // (\\server\share) and drive roots keep their prefix instead of being
  // rebuilt into a relative path that silently resolves against the build cwd.
  const paths: string[] = [];
  let current = trimTrailingSeparators(startDir);
  // On a UNC path the share itself is the root: \\server is not a directory, so
  // walking past \\server\share would emit paths that cannot exist.
  const uncRootLength = uncShareRootLength(current);
  for (;;) {
    const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
    if (cut < 0 || (uncRootLength > 0 && cut < uncRootLength)) break;
    const parent = cut === 0 ? current.slice(0, 1) : current.slice(0, cut);
    if (parent === current) break;
    paths.push(
      parent.endsWith(separator) ? `${parent}node_modules` : `${parent}${separator}node_modules`,
    );
    if (cut === 0) break;
    current = parent;
  }
  return paths;
}

const NativeMarkerManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeNativeMarkerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(NativeMarkerManifest),
);

/** Locate a package inside the pnpm store, which is where the real files live. */
const findStorePackageDirectory = Effect.fn("findStorePackageDirectory")(function* (
  repoRoot: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDir = path.join(repoRoot, "node_modules/.pnpm");
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* exists(storeDir))) return null;

  const flattened = `${packageName.replace("/", "+")}@`;
  const entries = yield* fs
    .readDirectory(storeDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const entry of entries) {
    if (!entry.startsWith(flattened)) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);
    if (yield* exists(candidate)) return candidate;
  }
  return null;
});

/** Whether a package builds or ships a native addon it loads at runtime. */
const hasNativeLoaderMarkers = Effect.fn("hasNativeLoaderMarkers")(function* (packageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(path.join(packageDir, "binding.gyp"))) return true;
  if (yield* exists(path.join(packageDir, "prebuilds"))) return true;

  const manifestPath = path.join(packageDir, "package.json");
  if (!(yield* exists(manifestPath))) return false;
  const source = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
  if (source === "") return false;
  const manifest = yield* Effect.try(() => decodeNativeMarkerManifest(source)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (manifest === null) return false;
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(
    (dependency) => dependency.startsWith("node-gyp-build"),
  );
});

export const copyDirectoryPreservingSymlinks = Effect.fn("copyDirectoryPreservingSymlinks")(
  function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Effect's Node implementation delegates directory copies to fs.cp, whose
    // default rewrites links into absolute source-tree references. Recreate every
    // in-tree directory link as a junction rooted in the isolated copy so the
    // probe cannot resolve through staging and Windows needs no symlink privilege.
    yield* fs.copy(source, destination);

    const restoreRelativeSymlinks = (
      sourceDirectory: string,
      destinationDirectory: string,
    ): Effect.Effect<void, PlatformError | BundleNotSelfContainedError> =>
      Effect.gen(function* () {
        for (const entry of yield* fs.readDirectory(sourceDirectory)) {
          const sourceEntry = path.join(sourceDirectory, entry);
          const destinationEntry = path.join(destinationDirectory, entry);
          const linkTarget = yield* fs.readLink(sourceEntry).pipe(Effect.option);
          if (Option.isSome(linkTarget)) {
            const absoluteSourceTarget = path.isAbsolute(linkTarget.value)
              ? linkTarget.value
              : path.resolve(path.dirname(sourceEntry), linkTarget.value);
            const sourceRelativeTarget = path.relative(source, absoluteSourceTarget);
            if (
              sourceRelativeTarget === ".." ||
              sourceRelativeTarget.startsWith(`..${path.sep}`) ||
              path.isAbsolute(sourceRelativeTarget)
            ) {
              return yield* new BundleNotSelfContainedError({
                exitCode: -1,
                output: `Refusing to copy symlink ${sourceEntry}: its target ${absoluteSourceTarget} escapes the packaged tree.`,
              });
            }
            const target = path.join(destination, sourceRelativeTarget);
            yield* fs.remove(destinationEntry, { recursive: true, force: true });
            yield* Effect.tryPromise({
              try: () => NodeFSP.symlink(target, destinationEntry, "junction"),
              catch: (cause) =>
                new BundleNotSelfContainedError({
                  exitCode: -1,
                  output: `Could not isolate ${sourceEntry}: ${String(cause)}`,
                }),
            });
          } else {
            const info = yield* fs.stat(sourceEntry);
            if (info.type === "Directory") {
              yield* restoreRelativeSymlinks(sourceEntry, destinationEntry);
            }
          }
        }
      });

    yield* restoreRelativeSymlinks(source, destination);
  },
);

const verifyPackagedBundleIsSelfContained = Effect.fn("verifyPackagedBundleIsSelfContained")(
  function* (input: { readonly stageDistDir: string; readonly verbose: boolean }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // electron-builder names this win-unpacked, win-arm64-unpacked, and so on.
    const distEntries = yield* fs
      .readDirectory(input.stageDistDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    let unpackedRoot: string | null = null;
    for (const entry of distEntries) {
      const candidate = path.join(input.stageDistDir, entry, "resources/app.asar.unpacked");
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        unpackedRoot = candidate;
        break;
      }
    }
    // Nothing to verify rather than silently passing: a packaging layout change
    // should surface here instead of turning the check into a no-op.
    if (unpackedRoot === null) {
      return yield* new BundleNotSelfContainedError({
        exitCode: -1,
        output: `No */resources/app.asar.unpacked directory under ${input.stageDistDir}; the bundle self-containment check found nothing to verify.`,
      });
    }

    const probeRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-bundle-selfcheck-",
    });
    const probeApp = path.join(probeRoot, "app");
    yield* copyDirectoryPreservingSymlinks(unpackedRoot, probeApp);

    // Guard the guard: if anything above the probe provides a node_modules, a
    // missing dependency would resolve there and the check would pass while the
    // packaged tree is broken.
    for (const candidate of ancestorNodeModulesPaths(probeApp, path.sep)) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return yield* new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Refusing to report success: ${candidate} is visible from the probe directory, so bare imports could resolve outside the packaged tree. Remove or rename it, or point TMPDIR somewhere without one.`,
        });
      }
    }

    const entryPoint = path.join(probeApp, "apps/server/dist/bin.mjs");
    if (!(yield* fs.exists(entryPoint).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new BundleNotSelfContainedError({
        exitCode: -1,
        output: `Expected the server entry at ${entryPoint}.`,
      });
    }

    // --version exercises the eagerly loaded module graph, which is where a
    // missing dependency shows up, without starting a server or touching disk
    // state. It does not cover lazily imported externals: node-pty is checked
    // by the WSL preflight probe at runtime, while ffi-rs, @ff-labs/fff-node
    // and the bun adapters are only covered by the unpack globs and the
    // inlined-native check below.
    yield* runCommand(
      ChildProcess.make(
        process.execPath,
        // --no-global-search-paths because clearing NODE_PATH is not enough:
        // CommonJS resolution still falls back to $HOME/.node_modules,
        // $HOME/.node_libraries and the install prefix, so a globally installed
        // copy of a missing dependency would quietly satisfy this check.
        ["--no-global-search-paths", entryPoint, "--version"],
        {
          cwd: probeApp,
          stdout: "pipe",
          stderr: "pipe",
          // NODE_PATH would let a createRequire call inside the bundle resolve
          // a missing external from outside the packaged tree, which is the
          // whole thing this is trying to rule out.
          env: { ...process.env, NODE_PATH: "" },
        },
      ),
      { label: "bundle self-containment check (node bin.mjs --version)", verbose: input.verbose },
    ).pipe(
      // Printing a version should be immediate. A regression that blocks (on
      // stdin, a port, a lock) would otherwise hang release CI until the job
      // times out with nothing useful in the log.
      Effect.timeout(BUNDLE_SELF_CHECK_TIMEOUT),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new BundleNotSelfContainedError({
            exitCode: -1,
            output: `The packaged bundle did not print its version within ${Duration.toSeconds(BUNDLE_SELF_CHECK_TIMEOUT)}s; it is hanging rather than failing to resolve.`,
          }),
        ),
      ),
      Effect.catchTag("BuildCommandFailedError", (error) =>
        Effect.fail(
          new BundleNotSelfContainedError({
            exitCode: error.exitCode,
            output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
          }),
        ),
      ),
    );
  },
);

const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const executableName = resourceMonitorExecutableName(input.platform);
  const rustTargets = resolveResourceMonitorRustTargets(input.platform, input.arch);
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    const spawnCommand = yield* resolveSpawnCommand("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      manifestPath,
      "--target",
      rustTarget,
    ]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.repoRoot,
        shell: spawnCommand.shell,
      }),
      {
        label: `cargo build resource monitor (${rustTarget})`,
        verbose: input.verbose,
      },
    );

    const binaryPath = path.join(
      input.repoRoot,
      "native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    );
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: input.platform,
        arch: input.arch,
      });
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  if (input.platform !== "win") {
    yield* fs.chmod(destinationPath, 0o755);
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
        { label: `sips icon ${size}x${size}`, verbose },
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
        { label: `sips icon ${size}x${size}@2x`, verbose },
      );
    }

    yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
      label: "iconutil icns",
      verbose,
    });
  });
}

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "mac",
        sourcePath: sourcePng,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
      label: "sips mac icon",
      verbose,
    });

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "linux",
        sourcePath: sourcePng,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);

    const iconsDir = path.join(stageResourcesDir, "icons");
    yield* fs.makeDirectory(iconsDir, { recursive: true });
    for (const iconSize of LINUX_ICON_SIZES) {
      yield* stageLinuxIconSize(
        sourcePng,
        path.join(iconsDir, `${iconSize}x${iconSize}.png`),
        iconSize,
        verbose,
      );
    }
  });
}

export function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch((primaryCause) =>
      resize("convert").pipe(
        Effect.mapError(
          (fallbackCause) =>
            new LinuxIconResizeError({
              operation: "resize",
              iconSize,
              primaryTool: "magick",
              fallbackTool: "convert",
              cause: new AggregateError(
                [primaryCause, fallbackCause],
                "Both Linux icon resize tool attempts failed.",
                { cause: primaryCause },
              ),
            }),
        ),
      ),
    ),
  );
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "win",
        sourcePath: sourceIco,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  });
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, dependencySpec]) =>
        dependencyName !== "electron" && !dependencySpec.startsWith("workspace:"),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

export const resolveGitHubPublishConfig = Effect.fn("resolveGitHubPublishConfig")(function* (
  updateChannel: "latest" | "nightly",
) {
  const env = yield* Config.all({
    updateRepository: Config.string("T3CODE_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
    githubRepository: Config.string("GITHUB_REPOSITORY").pipe(Config.option),
  });
  const rawRepo = (
    Option.getOrUndefined(env.updateRepository)?.trim() ||
    Option.getOrUndefined(env.githubRepository)?.trim() ||
    ""
  ).trim();
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
});

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3 Code (Nightly)"
    : (desktopPackageJson.productName ?? "T3 Code");
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
  macPasskeySigning:
    | {
        readonly entitlementsPath: string;
        readonly provisioningProfilePath: string;
      }
    | undefined,
) {
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: resolveDesktopProductName(version),
    artifactName: "T3-Code-${version}-${arch}.${ext}",
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    files: [...DESKTOP_FILE_EXCLUSIONS],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    // Only the Windows WSL backend needs files outside the asar (see
    // WINDOWS_ASAR_UNPACK); macOS and Linux stay packed — smart unpack
    // extracts native libraries, which fff-node finds in app.asar.unpacked.
    ...(platform === "win" ? { asarUnpack: [...WINDOWS_ASAR_UNPACK] } : {}),
    extraResources: DESKTOP_EXTRA_RESOURCES,
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  const publishConfig = yield* resolveGitHubPublishConfig(updateChannel);
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: resolveMockUpdateServerUrl(mockUpdateServerPort),
      },
    ];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      protocols: [
        {
          name: "T3 Code",
          schemes: ["t3code", "t3code-dev"],
        },
      ],
      ...(macPasskeySigning
        ? {
            entitlements: macPasskeySigning.entitlementsPath,
            provisioningProfile: macPasskeySigning.provisioningProfilePath,
          }
        : {}),
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      executableName: "t3code",
      icon: "icons",
      category: "Development",
      // electron-builder turns these into MimeType=x-scheme-handler/<scheme>;
      // in the .desktop entry (Exec already gets %U), so browsers can hand
      // t3code:// OAuth callbacks to the app.
      protocols: [
        {
          name: "T3 Code",
          schemes: ["t3code", "t3code-dev"],
        },
      ],
      desktop: {
        entry: {
          StartupWMClass: "t3code",
        },
      },
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
      // Resource editing applies the product metadata and icon independently
      // of code signing. Disabling it for local unsigned builds leaves the
      // packaged executable with Electron's stock icon.
      signAndEditExecutable: true,
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng, verbose);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

// Stage the prebuilt Linux node-pty binary into the packaged app so the WSL
// backend never compiles on the user's machine. node-pty publishes no Linux
// prebuilt and the WSL Linux Node can't load the Windows/Electron binary, so the
// Linux CI job builds pty.node and hands it here. We drop it into the staged
// node-pty's prebuilds/linux-<arch>/ with a t3code marker the WSL preflight
// checks (arch + node-pty version; the binary is N-API, hence ABI-stable across
// Node versions). A missing prebuild is a warning, not an error, so local and
// non-Windows builds still succeed — they just won't ship a working WSL backend.
const stageWslNodePtyPrebuild = Effect.fn("stageWslNodePtyPrebuild")(function* (input: {
  readonly stageAppDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly prebuildPath: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.prebuildPath === undefined) {
    yield* Effect.logWarning(
      "[desktop-artifact] No WSL node-pty prebuild provided (--wsl-prebuild / T3CODE_DESKTOP_WSL_PREBUILD); the packaged WSL backend will not start until a Linux pty.node is bundled.",
    );
    return;
  }

  // WSL runs the same CPU arch as the Windows host; universal is mac-only.
  const linuxArch = input.arch === "x64" ? "x64" : input.arch === "arm64" ? "arm64" : undefined;
  if (linuxArch === undefined) {
    yield* Effect.logWarning(
      `[desktop-artifact] No WSL node-pty prebuild mapping for arch "${input.arch}"; skipping WSL backend bundling.`,
    );
    return;
  }

  const prebuildExists = yield* fs
    .exists(input.prebuildPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!prebuildExists) {
    return yield* new WslNodePtyPrebuildMissingError({
      prebuildPath: input.prebuildPath,
    });
  }

  // Resolve through the (pnpm) symlink so we write into the stage's own node-pty
  // copy, never a shared content-addressable store.
  const nodePtyLink = path.join(input.stageAppDir, "node_modules", "node-pty");
  const nodePtyDir = yield* fs.realPath(nodePtyLink).pipe(Effect.orElseSucceed(() => nodePtyLink));

  const manifestPath = path.join(nodePtyDir, "package.json");
  const pkgRaw = yield* fs.readFileString(manifestPath);
  const manifest = yield* decodeNodePtyManifest(pkgRaw).pipe(
    Effect.mapError(
      (cause) =>
        new WslNodePtyManifestReadError({
          manifestPath,
          cause,
        }),
    ),
  );
  const nodePtyVersion = manifest.version;

  const prebuildDir = path.join(nodePtyDir, "prebuilds", `linux-${linuxArch}`);
  yield* fs.makeDirectory(prebuildDir, { recursive: true });
  yield* fs.copyFile(input.prebuildPath, path.join(prebuildDir, "pty.node"));
  const markerJson = yield* encodeJsonString({ arch: linuxArch, nodePtyVersion });
  yield* fs.writeFileString(path.join(prebuildDir, "t3code-wsl-node-pty.json"), `${markerJson}\n`);

  yield* Effect.log(
    `[desktop-artifact] Staged WSL node-pty prebuild (linux-${linuxArch}, node-pty ${nodePtyVersion}).`,
  );
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new UnsupportedDesktopBuildPlatformError({
      platform: options.platform,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server-production",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }

  // Assert against the emitted bundle, not the bundler config. `alwaysBundle`
  // only forces packages IN, so a transitive dependency of an external package
  // is bundled by default however the predicate is written — that silently
  // inlined msgpackr-extract and its native loader while every list-based test
  // still passed. An inlined native loader resolves its prebuilds relative to
  // the bundle and quietly falls back to a slower pure-JS path, so this fails
  // the build rather than shipping a silent regression.
  {
    const chunkNames = (yield* fs.readDirectory(distDirs.serverDist)).filter((entry) =>
      entry.endsWith(".mjs"),
    );
    let totalRegions = 0;
    const inlined = new Set<string>();
    const inlinedPackages = new Set<string>();
    for (const chunkName of chunkNames) {
      const source = yield* fs.readFileString(path.join(distDirs.serverDist, chunkName));
      const scan = findInlinedExternalPackages(source);
      totalRegions += scan.regionCount;
      for (const name of scan.inlined) inlined.add(name);
      for (const name of scan.inlinedPackages) inlinedPackages.add(name);
    }
    if (inlined.size > 0) {
      return yield* new InlinedExternalPackageError({
        packages: [...inlined].sort(),
      });
    }
    // No regions at all means the scan went blind (marker format changed), not
    // that the bundle is clean.
    if (totalRegions === 0) {
      return yield* new InlinedExternalPackageError({
        packages: ["<no module regions found; the bundle scan needs updating>"],
      });
    }
    // The check above is one-directional: it only proves nothing external got
    // inlined. A regression to externalizing everything would also pass it,
    // since source-file regions still exist -- and that is the failure this
    // whole change exists to prevent, because those packages are not in the
    // unpack globs and the WSL backend would die on ERR_MODULE_NOT_FOUND.
    // `effect` is imported by every server module, so it is inlined in any
    // correctly bundled build.
    // The list-based check above only sees packages someone already thought to
    // list. bufferutil and utf-8-validate were inlined for exactly that reason:
    // native, but absent from the list, so nothing flagged them. Ask the store
    // what each inlined package actually is instead.
    const nativeInlined: string[] = [];
    for (const name of [...inlinedPackages].sort()) {
      const packageDir = yield* findStorePackageDirectory(repoRoot, name);
      if (packageDir === null) continue;
      if (yield* hasNativeLoaderMarkers(packageDir)) nativeInlined.push(name);
    }
    if (nativeInlined.length > 0) {
      return yield* new InlinedNativePackageError({ packages: nativeInlined });
    }

    if (!inlinedPackages.has(BUNDLE_SELF_CONTAINED_SENTINEL)) {
      return yield* new ExternalizedBundleError({
        sentinel: BUNDLE_SELF_CONTAINED_SENTINEL,
        inlinedPackageCount: inlinedPackages.size,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = resolveDesktopWebAssetBrand(appVersion);
  yield* applyWebBrandAssets(webAssetBrand, "apps/server/dist/client");
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const configuredMacPasskeySigning =
    options.platform === "mac" && options.signed
      ? yield* Effect.try({
          try: () => resolveMacPasskeySigningConfiguration(loadRepoEnv({ repoRoot })),
          catch: MacPasskeySigningConfigurationResolutionError.fromCause,
        })
      : undefined;
  const macPasskeySigning = configuredMacPasskeySigning
    ? {
        ...configuredMacPasskeySigning,
        provisioningProfilePath: path.resolve(
          repoRoot,
          configuredMacPasskeySigning.provisioningProfilePath,
        ),
      }
    : undefined;
  const macEntitlementsPath = macPasskeySigning
    ? path.join(stageAppDir, "entitlements.mac.plist")
    : undefined;
  if (macPasskeySigning && macEntitlementsPath) {
    if (!(yield* fs.exists(macPasskeySigning.provisioningProfilePath))) {
      return yield* new MacProvisioningProfileNotFoundError({
        provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
      });
    }
    yield* fs.writeFileString(macEntitlementsPath, renderMacPasskeyEntitlements(macPasskeySigning));
  }

  const stageDependencies = {
    ...resolvedServerDependencies,
    ...resolvedDesktopRuntimeDependencies,
    ...resolveFffNativeDependencies(
      options.platform,
      options.arch,
      serverPackageJson.dependencies["@ff-labs/fff-node"],
    ),
    // Windows artifacts also bundle the same-architecture WSL Linux backend, which loads the
    // fff native binary through ffi-rs. The platform fff binary above is the
    // host's (win32), so promote the matching Linux fff binaries too; without
    // them file-finding in WSL fails to load its Linux native package.
    ...(options.platform === "win"
      ? resolveFffNativeDependencies(
          "linux",
          options.arch,
          serverPackageJson.dependencies["@ff-labs/fff-node"],
        )
      : {}),
  };
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const stagePackageJson: StagePackageJson = {
    name: "t3code",
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description: "T3 Code desktop build",
    author: "T3 Tools",
    main: "apps/desktop/dist-electron/main.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
      macPasskeySigning && macEntitlementsPath
        ? {
            entitlementsPath: macEntitlementsPath,
            provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
          }
        : undefined,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    platform: options.platform,
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );
  yield* stageClerkPasskeyNativeBinaries(stageAppDir, options.platform, options.arch);

  // WSL is Windows-only, so only the Windows artifact carries the Linux backend
  // binary; other platforms ignore the prebuild input.
  if (options.platform === "win") {
    yield* stageWslNodePtyPrebuild({
      stageAppDir,
      arch: options.arch,
      prebuildPath: options.wslPrebuild,
    });
  }

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (hostPlatform === "win32") {
    const python = yield* resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }
  if (options.verbose) {
    buildEnv.DEBUG =
      buildEnv.DEBUG === undefined
        ? "electron-builder,electron-builder:*"
        : `${buildEnv.DEBUG},electron-builder,electron-builder:*`;
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@t3tools/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @t3tools/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  // Prove the packaged bundle is self-contained by loading it the way the WSL
  // backend does, rather than by reasoning about the emitted source.
  //
  // Static analysis kept getting this wrong here. Scanning for bare imports
  // matched specifiers inside effect's JSDoc examples and inside ajv's runtime
  // codegen template, and asserting that one sentinel package was inlined
  // missed a build that inlined `effect` while leaving `yaml` external. Node's
  // resolver has no such ambiguity: it either finds every import or it does not.
  //
  // Only Windows unpacks anything; macOS and Linux keep the whole tree inside
  // the asar, where this check has nothing to look at.
  if (options.platform === "win") {
    yield* verifyPackagedBundleIsSelfContained({ stageDistDir, verbose: options.verbose });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: T3CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.integer("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
  wslPrebuild: Flag.string("wsl-prebuild").pipe(
    Flag.withDescription(
      "Path to a prebuilt Linux node-pty (pty.node) for the target arch, staged for the WSL backend (env: T3CODE_DESKTOP_WSL_PREBUILD).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
