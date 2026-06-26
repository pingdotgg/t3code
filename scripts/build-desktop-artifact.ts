#!/usr/bin/env node

import * as NodeModule from "node:module";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

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
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
  }),
});

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
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
  readonly overrides: Record<string, unknown>;
  readonly pnpm?: {
    readonly patchedDependencies?: Record<string, string>;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ASAR_UNPACK = ["node_modules/@ff-labs/fff-bin-*/**/*"] as const;

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

export function createStageWorkspaceConfig(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): typeof StageWorkspaceConfig.Type {
  return {
    supportedArchitectures: {
      os: [platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux"],
      cpu: arch === "universal" ? ["arm64", "x64"] : [arch],
    },
  };
}

export function createStagePnpmConfig(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): StagePackageJson["pnpm"] | undefined {
  const stagePatchedDependencies = Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );

  return Object.keys(stagePatchedDependencies).length > 0
    ? { patchedDependencies: stagePatchedDependencies }
    : undefined;
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
    asarUnpack: [...DESKTOP_ASAR_UNPACK],
    directories: {
      buildResources: "apps/desktop/resources",
    },
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
      desktop: {
        entry: {
          StartupWMClass: "t3code",
        },
      },
    };
    // TODO: Remove this once electron-builder defaults to the static AppImage runtime.
    // Ubuntu 22.04+ does not install libfuse2 by default, so we pin the static runtime here.
    buildConfig.toolsets = {
      appimage: "1.0.2",
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    } else {
      winConfig.signAndEditExecutable = false;
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

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

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
  };
  const stagePnpmConfig = createStagePnpmConfig(workspacePatchedDependencies, stageDependencies);
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
    overrides: resolvedOverrides,
    ...(stagePnpmConfig ? { pnpm: stagePnpmConfig } : {}),
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig(options.platform, options.arch);
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(workspacePatchedDependencies).length > 0) {
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

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
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
