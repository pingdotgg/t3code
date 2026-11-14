import {
  ACP_REGISTRY_MAX_AGENTS,
  AcpRegistryOperationError,
  AcpRegistryOperationErrorReason,
  TrimmedNonEmptyString,
  type AcpRegistryManagedBinaryUninstallInput,
  type AcpRegistryManagedBinaryUninstallResult,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type AcpRegistryDistribution as AcpRegistryDistributionKind,
} from "@t3tools/contracts";
import type { AcpRegistryDistributionPreference } from "../settings.ts";
import type { AcpRegistrySettings } from "../settings.ts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  mergePathEntries,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { sha256 } from "@noble/hashes/sha2";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpRegistryCatalog } from "./AcpRegistrySupport.ts";


export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export const MAX_REGISTRY_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
// Archive listings can exceed the output of package-manager commands.
export const MAX_ARCHIVE_LISTING_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
// Older clients omit the limit and validate responses against a 20-agent cap.
export const DEFAULT_SEARCH_LIMIT = 20;
export const REGISTRY_REQUEST_TIMEOUT = "30 seconds";
// Searches reuse an index fetched this recently; prepare always fetches the latest.
export const REGISTRY_SEARCH_MAX_AGE_MS = 5 * 60 * 1_000;
export const ARCHIVE_REQUEST_TIMEOUT = "20 minutes";
export const PACKAGE_INSTALL_TIMEOUT = "20 minutes";
export const PACKAGE_QUERY_TIMEOUT = "30 seconds";

export const BoundedAgentId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
);
export const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
// Versions become install directory names, so "." and ".." must not decode.
export const BoundedVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
);
export const BoundedDescription = Schema.String.check(Schema.isMaxLength(1_024));
export const BoundedMetadata = Schema.String.check(Schema.isMaxLength(256));
export const BoundedArgument = Schema.String.check(Schema.isMaxLength(1_024));
export const PackageCommandName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/iu),
);
export const isPackageCommandName = Schema.is(PackageCommandName);
export const EXACT_RUNNER_VERSION = "v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
export const EXACT_NPX_PACKAGE = new RegExp(
  `^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${EXACT_RUNNER_VERSION}$`,
  "iu",
);
export const EXACT_UVX_PACKAGE = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${EXACT_RUNNER_VERSION}$`, "iu");
export const NpxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_NPX_PACKAGE.test(value) || "ACP Registry npx packages must include an exact version.",
  ),
);
export const UvxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_UVX_PACKAGE.test(value) || "ACP Registry uvx packages must include an exact version.",
  ),
);
export const HttpsUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" && url.username.length === 0 && url.password.length === 0) ||
        "ACP Registry URLs must use HTTPS without embedded credentials."
      );
    } catch {
      return "ACP Registry URLs must be valid absolute URLs.";
    }
  }),
);

export const AcpRegistryPackageDistributionFields = {
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
} as const;
export const AcpRegistryNpxDistribution = Schema.Struct({
  package: NpxPackage,
  ...AcpRegistryPackageDistributionFields,
});
export const AcpRegistryUvxDistribution = Schema.Struct({
  package: UvxPackage,
  ...AcpRegistryPackageDistributionFields,
});

export const AcpRegistryBinaryTarget = Schema.Struct({
  archive: HttpsUrl,
  cmd: BoundedArgument,
  sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/iu))),
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
});

export const AcpRegistryAgent = Schema.Struct({
  id: BoundedAgentId,
  name: BoundedName,
  version: BoundedVersion,
  description: BoundedDescription,
  authors: Schema.optionalKey(Schema.Array(BoundedMetadata).check(Schema.isMaxLength(16))),
  license: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  website: Schema.optionalKey(HttpsUrl),
  repository: Schema.optionalKey(HttpsUrl),
  icon: Schema.optionalKey(HttpsUrl),
  distribution: Schema.Struct({
    binary: Schema.optionalKey(Schema.Record(Schema.String, AcpRegistryBinaryTarget)),
    npx: Schema.optionalKey(AcpRegistryNpxDistribution),
    uvx: Schema.optionalKey(AcpRegistryUvxDistribution),
  }),
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;

export const NpmPackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.Union([BoundedArgument, Schema.Record(PackageCommandName, BoundedArgument)]),
});

export const AcpRegistryPackageInstallReceipt = Schema.Struct({
  agentId: BoundedAgentId,
  agentVersion: BoundedVersion,
  distribution: Schema.Literals(["npx", "uvx"]),
  packageSpec: Schema.String,
  managerPath: Schema.String,
  binDirectory: Schema.String,
  executablePath: Schema.String,
  packageRoot: Schema.optional(Schema.String),
  packageVersion: Schema.optional(Schema.String),
});
export type AcpRegistryPackageInstallReceipt = typeof AcpRegistryPackageInstallReceipt.Type;

export const AcpRegistryIndexEnvelope = Schema.Struct({
  version: BoundedVersion,
  agents: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(ACP_REGISTRY_MAX_AGENTS)),
});
export interface AcpRegistryIndex {
  readonly version: string;
  readonly agents: ReadonlyArray<AcpRegistryAgent>;
}

export const decodeRegistryIndexEnvelope = Schema.decodeUnknownEffect(AcpRegistryIndexEnvelope);
export const decodeRegistryAgent = Schema.decodeUnknownOption(AcpRegistryAgent);
export const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
export const decodeNpmPackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NpmPackageManifest),
);
export const decodePackageInstallReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRegistryPackageInstallReceipt),
);
export const encodePackageInstallReceipt = Schema.encodeSync(
  Schema.fromJsonString(AcpRegistryPackageInstallReceipt),
);
export const decodeHttpsUrl = Schema.decodeUnknownEffect(HttpsUrl);
export const decodeBoundedAgentId = Schema.decodeUnknownEffect(BoundedAgentId);

export const AcpRegistryErrorReason = AcpRegistryOperationErrorReason;
export type AcpRegistryErrorReason = typeof AcpRegistryErrorReason.Type;

export class AcpRegistryError extends Schema.TaggedError<AcpRegistryError>()("AcpRegistryError", {
  reason: AcpRegistryErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export function toAcpRegistryOperationError(error: AcpRegistryError): AcpRegistryOperationError {
  return new AcpRegistryOperationError({
    reason: error.reason,
    message: error.detail,
    cause: error,
  });
}

export const isAcpRegistryError = Schema.is(AcpRegistryError);

export type AcpRegistryPlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export function resolveAcpRegistryPlatformTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): AcpRegistryPlatformTarget | undefined {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
  return os && arch ? (`${os}-${arch}` as AcpRegistryPlatformTarget) : undefined;
}

export function resolveAcpRegistryPlatformTargetCandidates(
  platformTarget: AcpRegistryPlatformTarget | undefined,
): ReadonlyArray<AcpRegistryPlatformTarget> {
  if (platformTarget === undefined) return [];
  // Windows 11 ARM can emulate x86_64 binaries when no native build exists.
  if (platformTarget === "windows-aarch64") {
    return ["windows-aarch64", "windows-x86_64"];
  }
  return [platformTarget];
}

export interface ExactPackageSpec {
  readonly name: string;
  readonly version: string;
}

export function parseNpxPackageSpec(packageSpec: string): ExactPackageSpec {
  const separator = packageSpec.lastIndexOf("@");
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + 1).replace(/^v/iu, ""),
  };
}

export function parseUvxPackageSpec(packageSpec: string): ExactPackageSpec {
  const equalsSeparator = packageSpec.lastIndexOf("==");
  const separator = equalsSeparator >= 0 ? equalsSeparator : packageSpec.lastIndexOf("@");
  const separatorLength = equalsSeparator >= 0 ? 2 : 1;
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + separatorLength).replace(/^v/iu, ""),
  };
}

export function packageManagerFor(distribution: AcpRegistryDistributionKind): "npm" | "uv" | undefined {
  return distribution === "npx" ? "npm" : distribution === "uvx" ? "uv" : undefined;
}

export function packageCommandCandidates(
  agent: AcpRegistryAgent,
  packageName: string,
): ReadonlyArray<string> {
  const unscopedPackageName = packageName.split("/").pop() ?? packageName;
  return Array.from(
    new Set(
      [agent.id, unscopedPackageName, unscopedPackageName.replace(/-acp$/u, "")].filter(
        isPackageCommandName,
      ),
    ),
  );
}

export function readEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment.PATH;
  return (
    environment.PATH ??
    Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1]
  );
}

export function withPreferredPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: mergePathEntries(directory, readEnvironmentPath(environment, platform), platform),
  };
}

export const acpRegistryManagedBinaryDirectories = Effect.fn("acpRegistryManagedBinaryDirectories")(
  function* (input: {
    readonly cacheDir: string;
    readonly toolsDir: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: NodeJS.Architecture;
  }): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = resolveAcpRegistryPlatformTarget(input.platform, input.architecture);
    const registryDirectory = path.join(input.cacheDir, "acp-registry");
    const installsDirectory = input.toolsDir;
    const packageReceiptsDirectory = path.join(registryDirectory, "package-installs");
    const listDirectories = (directory: string) =>
      fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): Array<string> => []));
    const directories: Array<string> = [];

    for (const receiptFile of (yield* listDirectories(packageReceiptsDirectory)).toSorted()) {
      const receipt = yield* fileSystem
        .readFileString(path.join(packageReceiptsDirectory, receiptFile))
        .pipe(
          Effect.map(decodePackageInstallReceipt),
          Effect.orElseSucceed(() => Option.none()),
        );
      if (
        Option.isSome(receipt) &&
        receipt.value.binDirectory ===
          path.join(
            installsDirectory,
            receipt.value.agentId,
            encodeURIComponent(receipt.value.agentVersion),
            receipt.value.distribution === "npx" ? "npm" : "python",
            ...(receipt.value.distribution === "npx" && input.platform === "win32" ? [] : ["bin"]),
          ) &&
        path.dirname(receipt.value.executablePath) === receipt.value.binDirectory &&
        (yield* fileSystem
          .exists(receipt.value.executablePath)
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        directories.push(receipt.value.binDirectory);
      }
    }

    if (target === undefined) return Array.from(new Set(directories));
    const cachedAgents = yield* fileSystem
      .readFileString(path.join(registryDirectory, "registry.json"))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.flatMap(decodeRegistryIndexEnvelope),
        Effect.map((envelope) =>
          envelope.agents.flatMap((candidate) => {
            const decoded = decodeRegistryAgent(candidate);
            return Option.isSome(decoded) ? [decoded.value] : [];
          }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<AcpRegistryAgent> => []),
      );
    const cachedAgentByInstall = new Map(
      cachedAgents.map(
        (agent) => [`${agent.id}\0${encodeURIComponent(agent.version)}`, agent] as const,
      ),
    );
    for (const agent of (yield* listDirectories(installsDirectory)).toSorted()) {
      const versions = (yield* listDirectories(path.join(installsDirectory, agent))).toSorted(
        (left, right) => right.localeCompare(left, undefined, { numeric: true }),
      );
      for (const version of versions) {
        for (const candidateTarget of resolveAcpRegistryPlatformTargetCandidates(target)) {
          const installRoot = path.join(installsDirectory, agent, version, candidateTarget);
          if (yield* fileSystem.exists(installRoot).pipe(Effect.orElseSucceed(() => false))) {
            const binaryTarget = cachedAgentByInstall.get(`${agent}\0${version}`)?.distribution
              .binary?.[candidateTarget];
            const commandSegments =
              binaryTarget === undefined
                ? undefined
                : normalizeRegistryCommandPath(binaryTarget.cmd);
            const directory =
              commandSegments === undefined
                ? installRoot
                : path.join(installRoot, ...commandSegments.slice(0, -1));
            if (yield* fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false))) {
              directories.push(directory);
            }
          }
        }
      }
    }
    return Array.from(new Set(directories));
  },
);

export interface ResolvedAcpRegistryDistribution {
  readonly kind: AcpRegistryDistributionKind;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly binaryTarget?: typeof AcpRegistryBinaryTarget.Type;
  readonly packageName?: string;
}

export function resolveAcpRegistryDistribution(input: {
  readonly agent: AcpRegistryAgent;
  readonly preference: AcpRegistryDistributionPreference;
  readonly platformTarget: AcpRegistryPlatformTarget | undefined;
}): ResolvedAcpRegistryDistribution | undefined {
  const { agent, platformTarget } = input;
  const binary = resolveAcpRegistryPlatformTargetCandidates(platformTarget)
    .map((candidate) => agent.distribution.binary?.[candidate])
    .find((entry) => entry !== undefined);
  const candidates: ReadonlyArray<AcpRegistryDistributionKind> =
    input.preference === "auto" ? ["binary", "npx", "uvx"] : [input.preference];

  for (const kind of candidates) {
    if (kind === "binary" && binary) {
      return {
        kind,
        args: binary.args ?? [],
        env: binary.env ?? {},
        binaryTarget: binary,
      };
    }
    if (kind === "npx" && agent.distribution.npx) {
      return {
        kind,
        args: agent.distribution.npx.args ?? [],
        env: agent.distribution.npx.env ?? {},
        packageName: agent.distribution.npx.package,
      };
    }
    if (kind === "uvx" && agent.distribution.uvx) {
      return {
        kind,
        args: agent.distribution.uvx.args ?? [],
        env: agent.distribution.uvx.env ?? {},
        packageName: agent.distribution.uvx.package,
      };
    }
  }
  return undefined;
}

export interface ResolvedAcpRegistryAgent {
  readonly agent?: AcpRegistryAgent;
  readonly distribution: AcpRegistryDistributionKind | "local";
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
}

export type AcpRegistryInspection =
  | { readonly status: "unconfigured" }
  | { readonly status: "not_found"; readonly agentId: string }
  | {
      readonly status: "unsupported";
      readonly agentId: string;
      readonly version: string;
    }
  | {
      readonly status: "missing_runner";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
      readonly runner: string;
    }
  | {
      readonly status: "missing_runner";
      readonly version: null;
      readonly distribution: "local";
    }
  | {
      readonly status: "unprepared";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: "binary";
    }
  | {
      readonly status: "ready";
      readonly agentId: string;
      readonly version: string | null;
      readonly distribution: AcpRegistryDistributionKind | "local";
      readonly documentationUrl?: string;
    };

export class AcpRegistryCatalog extends Context.Service<
  AcpRegistryCatalog,
  {
    readonly search: (
      input: AcpRegistrySearchInput,
    ) => Effect.Effect<AcpRegistrySearchResult, AcpRegistryError>;
    readonly prepare: (
      input: AcpRegistryPrepareInput,
    ) => Effect.Effect<AcpRegistryPrepareResult, AcpRegistryError>;
    readonly inspect: (
      settings: AcpRegistrySettings,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AcpRegistryInspection, AcpRegistryError>;
    readonly resolve: (
      settings: AcpRegistrySettings,
      cwd: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError>;
    readonly uninstallManagedBinary: (
      input: AcpRegistryManagedBinaryUninstallInput,
    ) => Effect.Effect<AcpRegistryManagedBinaryUninstallResult, AcpRegistryError>;
  }
>()("@t3tools/provider-acp-registry/server/AcpRegistryModel/AcpRegistryCatalog") {}

export const layer = (options: AcpRegistryCatalogOptions) =>
  Layer.effect(AcpRegistryCatalog, makeAcpRegistryCatalog(options));

export const layerFromHost = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const { paths } = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      return layer({
        cacheDir: paths.providerStatusCacheDir,
        toolsDir: path.join(paths.baseDir, "tools"),
      });
    }),
  ),
  AcpRegistryRuntimeCoordinator.layer,
);

export interface AcpRegistryCatalogOptions {
  readonly cacheDir: string;
  readonly toolsDir: string;
  readonly registryUrl?: string;
}

export const INSTALL_LOCK_RETRY_COUNT = 300;
export const INSTALL_LOCK_RETRY_DELAY = "100 millis";
export const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;
export const PREPARED_BINARY_RESERVATION_MS = 30 * 1_000;

export function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

export function normalizeRegistryCommandPath(command: string): ReadonlyArray<string> | undefined {
  const normalized = command.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments;
}

export function validateArchiveEntries(output: string): boolean {
  return output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .every((entry) => entry === "./" || normalizeRegistryCommandPath(entry) !== undefined);
}

export type ArchiveKind = "raw" | "tar_bz2" | "tar_gz" | "zip";

export function archiveKind(url: string): ArchiveKind {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar_gz";
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar_bz2";
  if (pathname.endsWith(".zip")) return "zip";
  return "raw";
}

export function archiveFileName(kind: ArchiveKind): string {
  switch (kind) {
    case "tar_gz":
      return "agent.tar.gz";
    case "tar_bz2":
      return "agent.tar.bz2";
    case "zip":
      return "agent.zip";
    case "raw":
      return "agent.bin";
  }
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function searchRank(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;

  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();
  const authors = (agent.authors ?? []).join(" ").toLowerCase();
  const description = agent.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;

  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}

