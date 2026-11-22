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
import * as Equal from "effect/Equal";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
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

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
// Install errors become the provider status message; npm and uv print the actionable error last.
const MAX_COMMAND_ERROR_TAIL_CHARS = 1_000;
// Archive listings can exceed the output of package-manager commands.
const MAX_ARCHIVE_LISTING_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
// Older clients omit the limit and validate responses against a 20-agent cap.
const DEFAULT_SEARCH_LIMIT = 20;
const REGISTRY_REQUEST_TIMEOUT = "30 seconds";
// Searches reuse an index fetched this recently; prepare always fetches the latest.
const REGISTRY_SEARCH_MAX_AGE_MS = 5 * 60 * 1_000;
const ARCHIVE_REQUEST_TIMEOUT = "20 minutes";
const ARCHIVE_EXTRACT_TIMEOUT = "5 minutes";
const PACKAGE_INSTALL_TIMEOUT = "20 minutes";
const PACKAGE_QUERY_TIMEOUT = "30 seconds";

const BoundedAgentId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
);
const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
// Versions become install directory names, so "." and ".." must not decode.
const BoundedVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
);
const BoundedDescription = Schema.String.check(Schema.isMaxLength(1_024));
const BoundedMetadata = Schema.String.check(Schema.isMaxLength(256));
const BoundedArgument = Schema.String.check(Schema.isMaxLength(1_024));
const PackageCommandName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/iu),
);
const isPackageCommandName = Schema.is(PackageCommandName);
const EXACT_RUNNER_VERSION = "v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const EXACT_NPX_PACKAGE = new RegExp(
  `^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${EXACT_RUNNER_VERSION}$`,
  "iu",
);
const EXACT_UVX_PACKAGE = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${EXACT_RUNNER_VERSION}$`, "iu");
const NpxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_NPX_PACKAGE.test(value) || "ACP Registry npx packages must include an exact version.",
  ),
);
const UvxPackage = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      EXACT_UVX_PACKAGE.test(value) || "ACP Registry uvx packages must include an exact version.",
  ),
);
const HttpsUrl = Schema.String.check(
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

const AcpRegistryPackageDistributionFields = {
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
} as const;
const AcpRegistryNpxDistribution = Schema.Struct({
  package: NpxPackage,
  ...AcpRegistryPackageDistributionFields,
});
const AcpRegistryUvxDistribution = Schema.Struct({
  package: UvxPackage,
  ...AcpRegistryPackageDistributionFields,
});

const AcpRegistryBinaryTarget = Schema.Struct({
  archive: HttpsUrl,
  cmd: BoundedArgument,
  sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/iu))),
  args: Schema.optionalKey(Schema.Array(BoundedArgument).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(BoundedMetadata, BoundedArgument)),
});

const AcpRegistryAgent = Schema.Struct({
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

const NpmPackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.Union([BoundedArgument, Schema.Record(PackageCommandName, BoundedArgument)]),
});

const AcpRegistryPackageInstallReceipt = Schema.Struct({
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
type AcpRegistryPackageInstallReceipt = typeof AcpRegistryPackageInstallReceipt.Type;

const AcpRegistryIndexEnvelope = Schema.Struct({
  version: BoundedVersion,
  agents: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(ACP_REGISTRY_MAX_AGENTS)),
});
export interface AcpRegistryIndex {
  readonly version: string;
  readonly agents: ReadonlyArray<AcpRegistryAgent>;
}

const decodeRegistryIndexEnvelope = Schema.decodeUnknownEffect(AcpRegistryIndexEnvelope);
const decodeRegistryAgent = Schema.decodeUnknownOption(AcpRegistryAgent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeNpmPackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NpmPackageManifest),
);
const decodePackageInstallReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRegistryPackageInstallReceipt),
);
const encodePackageInstallReceipt = Schema.encodeSync(
  Schema.fromJsonString(AcpRegistryPackageInstallReceipt),
);
const decodeHttpsUrl = Schema.decodeUnknownEffect(HttpsUrl);
const decodeBoundedAgentId = Schema.decodeUnknownEffect(BoundedAgentId);

export const AcpRegistryErrorReason = AcpRegistryOperationErrorReason;
export type AcpRegistryErrorReason = typeof AcpRegistryErrorReason.Type;

export const AcpRegistryFetchStage = Schema.Literals([
  "invalid_url",
  "http_request",
  "request_timeout",
  "response_read",
  "response_timeout",
  "response_too_large",
  "invalid_utf8",
  "invalid_json",
  "invalid_index",
]);
export type AcpRegistryFetchStage = typeof AcpRegistryFetchStage.Type;

export class AcpRegistryError extends Schema.TaggedError<AcpRegistryError>()("AcpRegistryError", {
  reason: AcpRegistryErrorReason,
  detail: Schema.String,
  stage: Schema.optional(AcpRegistryFetchStage),
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

const isAcpRegistryError = Schema.is(AcpRegistryError);

export type AcpRegistryPlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

function resolveAcpRegistryPlatformTarget(
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

function resolveAcpRegistryPlatformTargetCandidates(
  platformTarget: AcpRegistryPlatformTarget | undefined,
): ReadonlyArray<AcpRegistryPlatformTarget> {
  if (platformTarget === undefined) return [];
  // Windows 11 ARM can emulate x86_64 binaries when no native build exists.
  if (platformTarget === "windows-aarch64") {
    return ["windows-aarch64", "windows-x86_64"];
  }
  return [platformTarget];
}

interface ExactPackageSpec {
  readonly name: string;
  readonly version: string;
}

function parseNpxPackageSpec(packageSpec: string): ExactPackageSpec {
  const separator = packageSpec.lastIndexOf("@");
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + 1).replace(/^v/iu, ""),
  };
}

function parseUvxPackageSpec(packageSpec: string): ExactPackageSpec {
  const equalsSeparator = packageSpec.lastIndexOf("==");
  const separator = equalsSeparator >= 0 ? equalsSeparator : packageSpec.lastIndexOf("@");
  const separatorLength = equalsSeparator >= 0 ? 2 : 1;
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + separatorLength).replace(/^v/iu, ""),
  };
}

function packageManagerFor(distribution: AcpRegistryDistributionKind): "npm" | "uv" | undefined {
  return distribution === "npx" ? "npm" : distribution === "uvx" ? "uv" : undefined;
}

function packageCommandCandidates(
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

function readEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment.PATH;
  return (
    environment.PATH ??
    Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1]
  );
}

// Windows env keys are case-insensitive, and an inherited NPM_CONFIG_PREFIX would win over ours.
function withoutNpmPrefix(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== "npm_config_prefix"),
  );
}

function withPreferredPath(
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
    const agentDirectories = (yield* listDirectories(installsDirectory)).toSorted();
    if (agentDirectories.length === 0) return Array.from(new Set(directories));
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
    let legacyBaselinesCache: Readonly<Record<string, string>> | undefined | null = null;
    const getLegacyBaselines = Effect.gen(function* () {
      if (legacyBaselinesCache !== null) return legacyBaselinesCache;
      const result = yield* readLegacyBaselinesFile(
        fileSystem,
        path.join(registryDirectory, BINARY_LEGACY_BASELINES_FILENAME),
      );
      legacyBaselinesCache = result.status === "ok" ? result.baselines : undefined;
      return legacyBaselinesCache;
    });
    for (const agent of agentDirectories) {
      const versions = (yield* listDirectories(path.join(installsDirectory, agent))).toSorted(
        (left, right) =>
          compareRegistryVersions(safeDecodeVersionDir(right), safeDecodeVersionDir(left)),
      );
      for (const version of versions) {
        const versionRoot = path.join(installsDirectory, agent, version);
        const versionEntries = yield* listDirectories(versionRoot);
        for (const candidateTarget of resolveAcpRegistryPlatformTargetCandidates(target)) {
          const binaryTarget = cachedAgentByInstall.get(`${agent}\0${version}`)?.distribution
            .binary?.[candidateTarget];
          const preferredCommandSegments =
            binaryTarget === undefined ? undefined : normalizeRegistryCommandPath(binaryTarget.cmd);
          const targetKey =
            binaryTarget === undefined ? undefined : binaryArtifactIdentityKey(binaryTarget);
          const slotKey = legacyBaselineSlotKey(agent, version, candidateTarget);
          const matchingEntries = versionEntries.filter((entry) =>
            isBinaryPlatformEntry(entry, candidateTarget),
          );
          const inspectedRaw = yield* Effect.forEach(matchingEntries, (entry) =>
            Effect.gen(function* () {
              const installRoot = path.join(versionRoot, entry);
              const rawReceipt = yield* fileSystem
                .readFileString(path.join(installRoot, BINARY_ARTIFACT_RECEIPT_FILENAME))
                .pipe(Effect.option);
              const receipt = Option.flatMap(rawReceipt, decodeBinaryArtifactReceipt);
              return { entry, installRoot, receipt };
            }),
          );
          const hasReceiptedSlot = inspectedRaw.some((slot) => Option.isSome(slot.receipt));
          const inspectedSlots = yield* Effect.forEach(
            inspectedRaw,
            ({ entry, installRoot, receipt }) =>
              Effect.gen(function* () {
                const isPrimary = entry === candidateTarget;
                const receiptMatchesTarget =
                  binaryTarget !== undefined &&
                  Option.isSome(receipt) &&
                  binaryArtifactReceiptMatches(receipt.value, binaryTarget);
                // Skip un-receipted artifact-scoped leftovers; they cannot be valid installs.
                if (Option.isNone(receipt) && !isPrimary) {
                  return Option.none<{
                    readonly rank: number;
                    readonly installRoot: string;
                    readonly isPrimary: boolean;
                    readonly entry: string;
                    readonly directory: string;
                  }>();
                }
                // Skip superseded legacy primary slots once a receipted slot exists or a baseline disagrees.
                if (Option.isNone(receipt) && isPrimary) {
                  if (hasReceiptedSlot) {
                    return Option.none<{
                      readonly rank: number;
                      readonly installRoot: string;
                      readonly isPrimary: boolean;
                      readonly entry: string;
                      readonly directory: string;
                    }>();
                  }
                  if (targetKey !== undefined) {
                    const legacyBaselines = yield* getLegacyBaselines;
                    if (
                      legacyBaselines === undefined ||
                      (legacyBaselines[slotKey] !== undefined &&
                        legacyBaselines[slotKey] !== targetKey)
                    ) {
                      return Option.none<{
                        readonly rank: number;
                        readonly installRoot: string;
                        readonly isPrimary: boolean;
                        readonly entry: string;
                        readonly directory: string;
                      }>();
                    }
                  }
                }
                const receiptSegments = Option.isSome(receipt)
                  ? normalizeRegistryCommandPath(receipt.value.cmd)
                  : undefined;
                const segments = receiptMatchesTarget
                  ? (preferredCommandSegments ?? receiptSegments)
                  : (receiptSegments ?? (isPrimary ? preferredCommandSegments : undefined));
                const directory =
                  segments === undefined
                    ? installRoot
                    : path.join(installRoot, ...segments.slice(0, -1));
                const rank = receiptMatchesTarget ? 0 : Option.isSome(receipt) ? 1 : 2;
                return Option.some({ rank, installRoot, isPrimary, entry, directory });
              }),
          );
          const candidateSlots = inspectedSlots.filter(Option.isSome).map((slot) => slot.value);
          const rankCounts = new Map<number, number>();
          for (const slot of candidateSlots) {
            rankCounts.set(slot.rank, (rankCounts.get(slot.rank) ?? 0) + 1);
          }
          const rankedSlots = yield* Effect.forEach(candidateSlots, (slot) =>
            (rankCounts.get(slot.rank) ?? 0) > 1
              ? fileSystem.stat(slot.installRoot).pipe(
                  Effect.map((info) => ({
                    ...slot,
                    mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
                  })),
                  Effect.orElseSucceed(() => ({ ...slot, mtimeMs: 0 })),
                )
              : Effect.succeed({ ...slot, mtimeMs: 0 }),
          );
          const orderedSlots = rankedSlots.toSorted(
            (left, right) =>
              left.rank - right.rank ||
              right.mtimeMs - left.mtimeMs ||
              Number(left.isPrimary) - Number(right.isPrimary) ||
              left.entry.localeCompare(right.entry),
          );
          for (const slot of orderedSlots) {
            if (yield* fileSystem.exists(slot.directory).pipe(Effect.orElseSucceed(() => false))) {
              directories.push(slot.directory);
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

export interface AcpRegistryFailedTarget {
  readonly version: string;
  readonly launchIdentity: string;
  readonly indexRevision: number;
}

export interface ResolvedAcpRegistryAgent {
  readonly agent?: AcpRegistryAgent;
  readonly distribution: AcpRegistryDistributionKind | "local";
  readonly launchIdentity?: string;
  readonly indexRevision?: number;
  readonly fallback?: boolean;
  readonly failedTarget?: AcpRegistryFailedTarget;
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
}

export type AcpRegistryInspection =
  | { readonly status: "unconfigured" }
  | { readonly status: "not_found"; readonly agentId: string; readonly indexRevision?: number }
  | {
      readonly status: "unsupported";
      readonly agentId: string;
      readonly version: string;
      readonly indexRevision?: number;
    }
  | {
      readonly status: "missing_runner";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
      readonly runner: string;
      readonly indexRevision?: number;
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
      readonly indexRevision?: number;
    }
  | {
      readonly status: "ready";
      readonly agentId: string;
      readonly version: string | null;
      readonly distribution: AcpRegistryDistributionKind | "local";
      readonly launchIdentity?: string;
      readonly indexRevision?: number;
      readonly icon?: string;
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
    readonly refreshIndex: (options: {
      readonly maxAgeMs: number;
      readonly failureBackoffMs: number;
    }) => Effect.Effect<number, AcpRegistryError>;
    readonly currentIndexRevision: () => Effect.Effect<number>;
    readonly invalidateIndex: () => Effect.Effect<void>;
    readonly inspect: (
      settings: AcpRegistrySettings,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AcpRegistryInspection, AcpRegistryError>;
    readonly resolve: (
      settings: AcpRegistrySettings,
      cwd: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError, Scope.Scope>;
    readonly uninstallManagedBinary: (
      input: AcpRegistryManagedBinaryUninstallInput,
    ) => Effect.Effect<AcpRegistryManagedBinaryUninstallResult, AcpRegistryError>;
  }
>()("@t3tools/provider-acp-registry/server/AcpRegistrySupport/AcpRegistryCatalog") {}

const layer = (options: AcpRegistryCatalogOptions) =>
  Layer.effect(AcpRegistryCatalog, makeAcpRegistryCatalog(options));

export const layerFromHost = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const { paths } = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      return layer({
        cacheDir: paths.providerStatusCacheDir,
        toolsDir: path.join(paths.baseDir, "tools"),
        // Beside the built-in driver's runtime temp, short for Windows' 260-character path limit.
        runtimeTempDir: path.join(paths.stateDir, "antigravity-tmp", "acp-registry"),
      });
    }),
  ),
  AcpRegistryRuntimeCoordinator.layer,
);

export interface AcpRegistryCatalogOptions {
  readonly cacheDir: string;
  readonly toolsDir: string;
  /** Owns the temp files of agents whose unpacker cannot clean up after a kill. */
  readonly runtimeTempDir?: string;
  readonly registryUrl?: string;
}

// Unpacks about 140 MB into TEMP on every launch and cannot remove it when the process is killed.
const UNPACKING_AGENT_IDS: ReadonlySet<string> = new Set(["antigravity-acp"]);

const INSTALL_LOCK_RETRY_COUNT = 300;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;
const LEGACY_BASELINES_LOCK_RETRY_COUNT = 20;
const LEGACY_BASELINES_LOCK_STALE_MS = 10 * 1_000;
const PREPARED_BINARY_RESERVATION_MS = 30 * 1_000;

const BINARY_ARTIFACT_RECEIPT_FILENAME = ".t3-artifact.json";
const BINARY_LEGACY_BASELINES_FILENAME = "legacy-baselines.json";
const BINARY_LAUNCH_OPTIONS_FILENAME = "binary-launch-options.json";
// Sentinel recorded for unrecoverable unreceipted slots when rebuilding a corrupt baselines file;
// never equals binaryArtifactIdentityKey (which is always JSON) so the slot must be reinstalled.
const LEGACY_BASELINE_UNKNOWN = "unknown";
const BINARY_ARTIFACT_SLOT_HASH_LENGTH = 12;
const DOWNLOAD_RETRY_REGISTRY_BACKOFF_MS = 60 * 1_000;

const AcpRegistryBinaryArtifactReceipt = Schema.Struct({
  version: Schema.optional(Schema.String),
  archive: Schema.String,
  cmd: Schema.String,
  sha256: Schema.NullOr(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  launchOptionsRevision: Schema.optional(Schema.Finite),
  launchOptionsRecoveryId: Schema.optional(Schema.String),
  installId: Schema.optional(Schema.String),
});
type AcpRegistryBinaryArtifactReceipt = typeof AcpRegistryBinaryArtifactReceipt.Type;
const decodeBinaryArtifactReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRegistryBinaryArtifactReceipt),
);
const AcpRegistryBinaryLaunchOptionsStore = Schema.Record(
  Schema.String,
  AcpRegistryBinaryArtifactReceipt,
);
const decodeBinaryLaunchOptionsStore = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRegistryBinaryLaunchOptionsStore),
);

type BinaryLaunchOptionsReadResult =
  | {
      readonly status: "ok";
      readonly entries: Readonly<Record<string, AcpRegistryBinaryArtifactReceipt>>;
    }
  | { readonly status: "corrupt" }
  | { readonly status: "io_error" };

function readBinaryLaunchOptionsFile(
  fileSystem: FileSystem.FileSystem,
  launchOptionsPath: string,
): Effect.Effect<BinaryLaunchOptionsReadResult> {
  return fileSystem.readFileString(launchOptionsPath).pipe(
    Effect.map((raw): BinaryLaunchOptionsReadResult => {
      const decoded = decodeBinaryLaunchOptionsStore(raw);
      return Option.isSome(decoded)
        ? { status: "ok", entries: decoded.value }
        : { status: "corrupt" };
    }),
    Effect.catch((error) =>
      Effect.succeed<BinaryLaunchOptionsReadResult>(
        error.reason._tag === "NotFound" ? { status: "ok", entries: {} } : { status: "io_error" },
      ),
    ),
  );
}

const AcpRegistryLegacyBaselines = Schema.Record(Schema.String, Schema.String);
const decodeLegacyBaselines = Schema.decodeUnknownOption(
  Schema.fromJsonString(AcpRegistryLegacyBaselines),
);

type LegacyBaselinesReadResult =
  | { readonly status: "ok"; readonly baselines: Readonly<Record<string, string>> }
  | { readonly status: "corrupt" }
  | { readonly status: "io_error" };

function legacyBaselineSlotKey(
  agentId: string,
  encodedVersion: string,
  candidateTarget: AcpRegistryPlatformTarget,
): string {
  return `${agentId}\0${encodedVersion}\0${candidateTarget}`;
}

function legacyBaselineAgentUnknownKey(agentId: string): string {
  return `${agentId}\0*`;
}

function readLegacyBaselinesFile(
  fileSystem: FileSystem.FileSystem,
  baselinesPath: string,
): Effect.Effect<LegacyBaselinesReadResult> {
  return fileSystem.readFileString(baselinesPath).pipe(
    Effect.map((raw): LegacyBaselinesReadResult => {
      const decoded = decodeLegacyBaselines(raw);
      return Option.isSome(decoded)
        ? { status: "ok", baselines: decoded.value }
        : { status: "corrupt" };
    }),
    Effect.catch((error) =>
      Effect.succeed<LegacyBaselinesReadResult>(
        error.reason._tag === "NotFound" ? { status: "ok", baselines: {} } : { status: "io_error" },
      ),
    ),
  );
}

function safeDecodeVersionDir(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const NUMERIC_VERSION_IDENTIFIER = /^(?:0|[1-9]\d*)$/u;
const DIGITS_ONLY = /^\d+$/u;

function compareNumericStrings(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/u, "");
  const b = right.replace(/^0+(?=\d)/u, "");
  if (a.length !== b.length) return a.length - b.length;
  return compareText(a, b);
}

function compareRegistryVersions(left: string, right: string): number {
  const splitVersion = (raw: string) => {
    const stripped = raw.replace(/^v(?=\d)/iu, "").split("+", 1)[0] ?? raw;
    const hyphenIndex = stripped.indexOf("-");
    const core = hyphenIndex === -1 ? stripped : stripped.slice(0, hyphenIndex);
    const prerelease = hyphenIndex === -1 ? undefined : stripped.slice(hyphenIndex + 1);
    return {
      core: core.split("."),
      prerelease: prerelease === undefined ? undefined : prerelease.split("."),
    };
  };
  const a = splitVersion(left);
  const b = splitVersion(right);
  const maxLen = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < maxLen; index += 1) {
    const aPart = a.core[index] ?? "0";
    const bPart = b.core[index] ?? "0";
    if (aPart === bPart) continue;
    const diff =
      DIGITS_ONLY.test(aPart) && DIGITS_ONLY.test(bPart)
        ? compareNumericStrings(aPart, bPart)
        : compareText(aPart, bPart);
    if (diff !== 0) return diff;
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  // SemVer 2.0.0 §11.4: numeric identifiers compare numerically and have lower precedence than
  // non-numeric identifiers, which compare lexically in ASCII order.
  const minPre = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < minPre; index += 1) {
    const aId = a.prerelease[index]!;
    const bId = b.prerelease[index]!;
    if (aId === bId) continue;
    const aIsNum = NUMERIC_VERSION_IDENTIFIER.test(aId);
    const bIsNum = NUMERIC_VERSION_IDENTIFIER.test(bId);
    if (aIsNum && bIsNum) {
      const diff = compareNumericStrings(aId, bId);
      if (diff !== 0) return diff;
      continue;
    }
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return compareText(aId, bId);
  }
  return a.prerelease.length - b.prerelease.length;
}

function binaryArtifactIdentityKey(target: typeof AcpRegistryBinaryTarget.Type): string {
  return JSON.stringify({
    archive: target.archive,
    cmd: target.cmd,
    sha256: target.sha256 ?? null,
  });
}

function binaryArtifactDirName(
  platformTarget: AcpRegistryPlatformTarget,
  target: typeof AcpRegistryBinaryTarget.Type,
): string {
  const digest = Hex.encode(sha256(new TextEncoder().encode(binaryArtifactIdentityKey(target))));
  return `${platformTarget}-${digest.slice(0, BINARY_ARTIFACT_SLOT_HASH_LENGTH)}`;
}

function isBinaryPlatformEntry(entry: string, candidateTarget: AcpRegistryPlatformTarget): boolean {
  if (entry === candidateTarget) return true;
  if (!entry.startsWith(`${candidateTarget}-`)) return false;
  return /^[0-9a-f]{12}$/u.test(entry.slice(candidateTarget.length + 1));
}

function binaryArtifactReceiptMatches(
  receipt: AcpRegistryBinaryArtifactReceipt,
  target: typeof AcpRegistryBinaryTarget.Type,
): boolean {
  return (
    receipt.archive === target.archive &&
    receipt.cmd === target.cmd &&
    receipt.sha256 === (target.sha256 ?? null)
  );
}

function receiptMatchesInstall(
  candidate: AcpRegistryBinaryArtifactReceipt | undefined,
  receipt: AcpRegistryBinaryArtifactReceipt,
): candidate is AcpRegistryBinaryArtifactReceipt {
  return (
    candidate !== undefined &&
    candidate.archive === receipt.archive &&
    candidate.cmd === receipt.cmd &&
    (candidate.sha256 ?? null) === (receipt.sha256 ?? null) &&
    (candidate.installId ?? null) === (receipt.installId ?? null)
  );
}

function receiptMatchesLaunchOptions(
  receipt: AcpRegistryBinaryArtifactReceipt,
  target: typeof AcpRegistryBinaryTarget.Type,
): boolean {
  return (
    Equal.equals(receipt.args ?? [], target.args ?? []) &&
    Equal.equals(receipt.env ?? {}, target.env ?? {})
  );
}

function encodeBinaryArtifactReceipt(
  agent: AcpRegistryAgent,
  target: typeof AcpRegistryBinaryTarget.Type,
  options?: {
    readonly launchOptionsRevision?: number;
    readonly installId?: string;
  },
): string {
  return JSON.stringify({
    version: agent.version,
    archive: target.archive,
    cmd: target.cmd,
    sha256: target.sha256 ?? null,
    ...(target.args && target.args.length > 0 ? { args: target.args } : {}),
    ...(target.env && Object.keys(target.env).length > 0 ? { env: target.env } : {}),
    ...(options?.launchOptionsRevision !== undefined
      ? { launchOptionsRevision: options.launchOptionsRevision }
      : {}),
    ...(options?.installId !== undefined ? { installId: options.installId } : {}),
  });
}

function registryLaunchIdentity(input: {
  readonly version: string | null;
  readonly distribution: ResolvedAcpRegistryDistribution;
  readonly commandOverride?: string;
}): string {
  const envEntries = Object.entries(input.distribution.env).sort(([left], [right]) =>
    compareText(left, right),
  );
  if (input.commandOverride) {
    return JSON.stringify({
      commandOverride: input.commandOverride,
      args: input.distribution.args,
      env: envEntries,
    });
  }
  return JSON.stringify({
    version: input.version,
    kind: input.distribution.kind,
    ...(input.distribution.packageName ? { packageName: input.distribution.packageName } : {}),
    ...(input.distribution.binaryTarget
      ? {
          archive: input.distribution.binaryTarget.archive,
          cmd: input.distribution.binaryTarget.cmd,
          sha256: input.distribution.binaryTarget.sha256 ?? null,
        }
      : {}),
    args: input.distribution.args,
    env: envEntries,
  });
}

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

function normalizeRegistryCommandPath(command: string): ReadonlyArray<string> | undefined {
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

function validateArchiveEntries(output: string): boolean {
  return output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .every((entry) => entry === "./" || normalizeRegistryCommandPath(entry) !== undefined);
}

type ArchiveKind = "raw" | "tar_bz2" | "tar_gz" | "zip";

function archiveKind(url: string): ArchiveKind {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar_gz";
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar_bz2";
  if (pathname.endsWith(".zip")) return "zip";
  return "raw";
}

function archiveFileName(kind: ArchiveKind): string {
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchRank(agent: AcpRegistryAgent, query: string): number | undefined {
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

export const makeAcpRegistryCatalog = Effect.fn("AcpRegistryCatalog.make")(function* (
  input: AcpRegistryCatalogOptions,
): Effect.fn.Return<
  AcpRegistryCatalog["Service"],
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Digest.Digest
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderHost.ProviderHost
> {
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const sha256Hex = (data: Uint8Array) =>
    digester.digest(Digest.sha256, data).pipe(Effect.map(Hex.encode), Effect.orDie);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { settings: hostSettings } = yield* ProviderHost.ProviderHost;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const hostEnvironment = yield* HostProcess.Environment;
  const executableResolver = yield* SpawnExecutableResolution;
  const resolveExecutable = Effect.fn("AcpRegistryCatalog.resolveExecutable")(function* (
    command: string,
    environment: NodeJS.ProcessEnv,
  ) {
    return yield* Effect.promise(async () => executableResolver(command, platform, environment));
  });
  const platformTarget = resolveAcpRegistryPlatformTarget(platform, architecture);
  const registryUrl = input.registryUrl ?? ACP_REGISTRY_URL;
  const registryDirectory = path.join(input.cacheDir, "acp-registry");
  const registryCachePath = path.join(registryDirectory, "registry.json");
  const legacyBaselinesPath = path.join(registryDirectory, BINARY_LEGACY_BASELINES_FILENAME);
  const binaryLaunchOptionsPath = path.join(registryDirectory, BINARY_LAUNCH_OPTIONS_FILENAME);
  const installsDirectory = input.toolsDir;
  const agentInstallRoot = (agent: AcpRegistryAgent) =>
    path.join(installsDirectory, agent.id, encodeURIComponent(agent.version));
  const packageInstallRoot = (agent: AcpRegistryAgent, distribution: "npx" | "uvx") =>
    path.join(agentInstallRoot(agent), distribution === "npx" ? "npm" : "python");
  const packageBinDirectory = (agent: AcpRegistryAgent, distribution: "npx" | "uvx") =>
    distribution === "npx" && platform === "win32"
      ? packageInstallRoot(agent, distribution)
      : path.join(packageInstallRoot(agent, distribution), "bin");
  const packageReceiptsDirectory = path.join(registryDirectory, "package-installs");
  interface RegistryCacheState {
    readonly index: AcpRegistryIndex | undefined;
    // When the network last served index; unset until fetched, on fallback, or after invalidateIndex.
    readonly fetchedAtMs: number | undefined;
    // When a network fetch last failed; lets background max-age refreshes back off while offline.
    readonly failedAtMs: number | undefined;
    // Last network failure; lets coalesced or backed-off callers fail fast when uncached.
    readonly lastFailure: AcpRegistryError | undefined;
    // Advances only on a successful non-invalidated network fetch; shared by all queued callers.
    readonly fetchRevision: number;
    // Advances on any completed non-invalidated refresh attempt (fetch, fallback, or uncached failure).
    readonly attemptRevision: number;
    // Advances only when a network fetch succeeds with a different index than the previous one.
    readonly indexRevision: number;
    // Advances on invalidateIndex so an in-flight attempt started earlier cannot mark the cache fresh or backed off.
    readonly invalidationGeneration: number;
  }
  const registryState = yield* Ref.make<RegistryCacheState>({
    index: undefined,
    fetchedAtMs: undefined,
    failedAtMs: undefined,
    lastFailure: undefined,
    fetchRevision: 0,
    attemptRevision: 0,
    indexRevision: 0,
    invalidationGeneration: 0,
  });
  const registrySemaphore = yield* Semaphore.make(1);
  const legacyBaselinesSemaphore = yield* Semaphore.make(1);
  const launchOptionsSemaphore = yield* Semaphore.make(1);
  // Long installs must only block operations on the same agent.
  const installPermits = new Map<string, Semaphore.Semaphore>();
  const withInstallPermit = (agentId: string) => {
    const permit = installPermits.get(agentId) ?? Semaphore.makeUnsafe(1);
    installPermits.set(agentId, permit);
    return permit.withPermits(1);
  };
  const preparedBinaryReservations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  // In-memory mirror of durable legacy baselines so disk write errors still keep a superseded
  // pre-receipt binary from matching a newly published artifact at the same version.
  const legacyBaselineBySlotKey = new Map<string, string>();
  // True after an incomplete tools-directory scan or disk-index read error during baseline
  // discovery; requires positive baseline provenance before reusing unreceipted legacy installs.
  let legacyBaselineDiscoveryIncomplete = false;
  // In-memory mirror of uncommitted binary launch options when durable writes fail or cannot read
  // the sidecar; tracked separately from committed revisions so failed writes never outrank later
  // durable updates from another catalog.
  const pendingLaunchOptionsBySlotRoot = new Map<
    string,
    {
      readonly baseReceiptRevision: number;
      readonly baseDurableRevision: number;
      readonly baseRecoveryId: string | null;
      readonly receipt: AcpRegistryBinaryArtifactReceipt;
    }
  >();

  const runtimeTempDir = input.runtimeTempDir;
  if (runtimeTempDir !== undefined) {
    // Move leftovers of a previous server aside so the slow delete cannot race new runs.
    const parent = path.dirname(runtimeTempDir);
    const prefix = `${path.basename(runtimeTempDir)}.old-`;
    const retire = Effect.gen(function* () {
      if (yield* fileSystem.exists(runtimeTempDir)) {
        yield* fileSystem.makeTempDirectory({ directory: parent, prefix }).pipe(
          Effect.flatMap((retired) =>
            fileSystem.rename(runtimeTempDir, path.join(retired, "runtime")),
          ),
          Effect.catch(() => fileSystem.remove(runtimeTempDir, { recursive: true, force: true })),
        );
      }
      return yield* fileSystem.readDirectory(parent);
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const retired = (yield* retire).filter((entry) => entry.startsWith(prefix));
    yield* Effect.forkDetach(
      Effect.forEach(
        retired,
        (entry) =>
          fileSystem
            .remove(path.join(parent, entry), { recursive: true, force: true })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove leftover ACP agent temp files."),
              ),
            ),
        { discard: true },
      ),
    );
  }

  // One directory per process, removed after it exits; the next server start sweeps what Windows kept.
  const acquireRuntimeTempEnvironment = Effect.fn("AcpRegistryCatalog.acquireRuntimeTemp")(
    function* (root: string, environment: NodeJS.ProcessEnv) {
      const directory = yield* Effect.acquireRelease(
        fileSystem.makeDirectory(root, { recursive: true }).pipe(
          Effect.andThen(fileSystem.makeTempDirectory({ directory: root, prefix: "run-" })),
          Effect.mapError(
            (cause) =>
              new AcpRegistryError({
                reason: "install_failed",
                detail: "Could not create a temp directory for the ACP agent.",
                cause,
              }),
          ),
        ),
        (directory) => {
          const remove = fileSystem.remove(directory, { recursive: true, force: true });
          // Windows keeps a killed process's files locked for a few seconds after it exits.
          const retry = remove.pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
            Effect.catch(() => Effect.logWarning("Could not remove an ACP agent temp directory.")),
          );
          return remove.pipe(Effect.catch(() => Effect.asVoid(Effect.forkDetach(retry))));
        },
      );
      if (platform !== "win32") return { ...environment, TMPDIR: directory };
      // Windows env keys are case-insensitive; drop aliases so ours win.
      const rest = Object.fromEntries(
        Object.entries(environment).filter(([key]) => !["temp", "tmp"].includes(key.toLowerCase())),
      );
      return { ...rest, TEMP: directory, TMP: directory };
    },
  );

  const managerBinDirectory = Effect.fn("AcpRegistryCatalog.managerBinDirectory")(function* (
    runner: string,
  ) {
    const linkedTarget = yield* fileSystem.readLink(runner).pipe(Effect.option);
    if (Option.isNone(linkedTarget)) return path.dirname(runner);
    const target = path.isAbsolute(linkedTarget.value)
      ? linkedTarget.value
      : path.resolve(path.dirname(runner), linkedTarget.value);
    // Wrapper symlinks may identify the toolchain bin directory; npm-cli.js points inside npm instead.
    return path.basename(target) === path.basename(runner)
      ? path.dirname(target)
      : path.dirname(runner);
  });

  const reservePreparedBinary = Effect.fn("AcpRegistryCatalog.reservePreparedBinary")(function* (
    agentId: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(preparedBinaryReservations, (current) => {
      const next = new Map(Array.from(current).filter(([, expiresAt]) => expiresAt > now));
      next.set(agentId, now + PREPARED_BINARY_RESERVATION_MS);
      return next;
    });
  });

  const consumePreparedBinaryReservation = (agentId: string) =>
    Ref.update(preparedBinaryReservations, (current) => {
      if (!current.has(agentId)) return current;
      const next = new Map(current);
      next.delete(agentId);
      return next;
    });

  const hasPreparedBinaryReservation = Effect.fn("AcpRegistryCatalog.hasPreparedBinaryReservation")(
    function* (agentId: string) {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(preparedBinaryReservations, (current) => {
        const expiresAt = current.get(agentId);
        if (expiresAt === undefined || expiresAt <= now) {
          if (expiresAt === undefined) return [false, current] as const;
          const next = new Map(current);
          next.delete(agentId);
          return [false, next] as const;
        }
        return [true, current] as const;
      });
    },
  );

  const assertHttpsUrl = Effect.fn("AcpRegistryCatalog.assertHttpsUrl")(function* (
    value: string,
    detail: string,
    stage?: AcpRegistryFetchStage,
  ) {
    const valid = yield* decodeHttpsUrl(value).pipe(Effect.option);
    if (Option.isNone(valid)) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail,
        ...(stage === undefined ? {} : { stage }),
      });
    }
    return value;
  });

  const decodeRegistryText = Effect.fn("AcpRegistryCatalog.decodeRegistryText")(function* (
    text: string,
  ) {
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned invalid JSON.",
            stage: "invalid_json",
            cause,
          }),
      ),
    );
    const envelope = yield* decodeRegistryIndexEnvelope(decoded).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned an invalid index.",
            stage: "invalid_index",
            cause,
          }),
      ),
    );
    const agents = envelope.agents.flatMap((candidate) => {
      const decodedAgent = decodeRegistryAgent(candidate);
      return Option.isSome(decodedAgent) ? [decodedAgent.value] : [];
    });
    const discarded = envelope.agents.length - agents.length;
    if (discarded > 0) {
      yield* Effect.logWarning("ignored invalid ACP Registry entries", { discarded });
    }
    return { version: envelope.version, agents } satisfies AcpRegistryIndex;
  });

  const readCachedRegistry = fileSystem
    .readFileString(registryCachePath)
    .pipe(Effect.flatMap(decodeRegistryText), Effect.option);

  const writeRegistryCache = (text: string) =>
    random.uuidV4().pipe(
      Effect.flatMap((id) => {
        const temporaryPath = `${registryCachePath}.${process.pid}-${id}.tmp`;
        return fileSystem
          .makeDirectory(registryDirectory, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(temporaryPath, text)),
            Effect.andThen(fileSystem.rename(temporaryPath, registryCachePath)),
            Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          );
      }),
      Effect.ignore,
    );

  const fetchRegistry = Effect.fn("AcpRegistryCatalog.fetchRegistry")(function* () {
    yield* assertHttpsUrl(registryUrl, "ACP Registry index URL must use HTTPS.", "invalid_url");
    const response = yield* httpClient.execute(HttpClientRequest.get(registryUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: `Could not fetch ACP Registry index from ${registryUrl}.`,
            stage: "http_request",
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: REGISTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryError({
              reason: "registry_unavailable",
              detail: "Timed out fetching ACP Registry index.",
              stage: "request_timeout",
            }),
          ),
      }),
    );
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: MAX_REGISTRY_BYTES + 1,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "Could not read ACP Registry response body.",
            stage: "response_read",
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: REGISTRY_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryError({
              reason: "registry_unavailable",
              detail: "Timed out reading ACP Registry response body.",
              stage: "response_timeout",
            }),
          ),
      }),
    );
    if (collected.truncated || collected.bytes > MAX_REGISTRY_BYTES) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: `ACP Registry index exceeds ${MAX_REGISTRY_BYTES} bytes.`,
        stage: "response_too_large",
      });
    }
    if (collected.invalidUtf8) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "ACP Registry index is not valid UTF-8.",
        stage: "invalid_utf8",
      });
    }
    const registry = yield* decodeRegistryText(collected.text);
    return { registry, text: collected.text };
  });

  const acquireFileLock = Effect.fn("AcpRegistryCatalog.acquireFileLock")(function* (
    lockPath: string,
    options?: {
      readonly retryCount?: number;
      readonly staleMs?: number;
    },
  ) {
    const retryCount = options?.retryCount ?? INSTALL_LOCK_RETRY_COUNT;
    const staleMs = options?.staleMs ?? INSTALL_LOCK_STALE_MS;
    const token = yield* random.uuidV4();
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, token, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => isAlreadyExists(error),
          () => Effect.succeed(false),
        ),
      );
      if (acquired) return token;
      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > staleMs) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      // Keep the retry sleep interruptible inside acquireUseRelease so waiting on a busy lock
      // never blocks provider refreshes, foreground preemption, or shutdown.
      yield* Effect.interruptible(Effect.sleep(INSTALL_LOCK_RETRY_DELAY));
    }
    return yield* new AcpRegistryError({
      reason: "install_failed",
      detail: `Timed out waiting for ACP Registry install lock ${lockPath}.`,
    });
  });

  const withFileLock = <A, E, R>(
    lockPath: string,
    use: (isLockOwned: Effect.Effect<boolean>) => Effect.Effect<A, E, R>,
    options?: {
      readonly retryCount?: number;
      readonly staleMs?: number;
    },
  ) =>
    Effect.acquireUseRelease(
      acquireFileLock(lockPath, options),
      (token) =>
        use(
          fileSystem.readFileString(lockPath).pipe(
            Effect.map((current) => current === token),
            Effect.orElseSucceed(() => false),
          ),
        ),
      (token) =>
        fileSystem.readFileString(lockPath).pipe(
          Effect.flatMap((current) =>
            current === token ? fileSystem.remove(lockPath, { force: true }) : Effect.void,
          ),
          Effect.ignore,
        ),
    );

  const writeJsonFileAtomically = (targetPath: string, value: unknown) =>
    random.uuidV4().pipe(
      Effect.flatMap((id) => {
        const temporaryPath = `${targetPath}.${process.pid}-${id}.tmp`;
        return fileSystem
          .makeDirectory(registryDirectory, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.writeFileString(temporaryPath, JSON.stringify(value))),
            Effect.andThen(fileSystem.rename(temporaryPath, targetPath)),
            Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          );
      }),
    );

  const writeLegacyBaselinesAtomically = (baselines: Readonly<Record<string, string>>) =>
    writeJsonFileAtomically(legacyBaselinesPath, baselines);

  const withLegacyBaselinesLock = <A, E, R>(
    use: (isLockOwned: Effect.Effect<boolean>) => Effect.Effect<A, E, R>,
  ) =>
    legacyBaselinesSemaphore.withPermits(1)(
      fileSystem.makeDirectory(registryDirectory, { recursive: true }).pipe(
        Effect.andThen(
          withFileLock(`${legacyBaselinesPath}.lock`, use, {
            retryCount: LEGACY_BASELINES_LOCK_RETRY_COUNT,
            staleMs: LEGACY_BASELINES_LOCK_STALE_MS,
          }),
        ),
      ),
    );

  const withBinaryLaunchOptionsLock = <A, E, R>(
    use: (isLockOwned: Effect.Effect<boolean>) => Effect.Effect<A, E, R>,
  ) =>
    launchOptionsSemaphore.withPermits(1)(
      fileSystem.makeDirectory(registryDirectory, { recursive: true }).pipe(
        Effect.andThen(
          withFileLock(`${binaryLaunchOptionsPath}.lock`, use, {
            retryCount: LEGACY_BASELINES_LOCK_RETRY_COUNT,
            staleMs: LEGACY_BASELINES_LOCK_STALE_MS,
          }),
        ),
      ),
    );

  // Returns true when the desired state is durably persisted on disk (or already superseded by a
  // newer revision), false on transient I/O errors or lock loss (leaving disk untouched).
  // Corrupt sidecar files are copied aside and repaired cleanly once the lock is verified.
  const updateBinaryLaunchOptionsStore = Effect.fn(
    "AcpRegistryCatalog.updateBinaryLaunchOptionsStore",
  )(function* (
    mutate: (
      entries: Readonly<Record<string, AcpRegistryBinaryArtifactReceipt>>,
    ) => Readonly<Record<string, AcpRegistryBinaryArtifactReceipt>> | null,
  ) {
    return yield* withBinaryLaunchOptionsLock((isLockOwned) =>
      Effect.gen(function* () {
        const current = yield* readBinaryLaunchOptionsFile(fileSystem, binaryLaunchOptionsPath);
        if (current.status === "io_error") return false;
        const isCorrupt = current.status === "corrupt";
        const baseEntries = isCorrupt ? {} : current.entries;
        const nextEntries = mutate(baseEntries);
        if (nextEntries === null && !isCorrupt) return true;
        if (!(yield* isLockOwned)) return false;
        if (isCorrupt) {
          yield* fileSystem
            .copyFile(binaryLaunchOptionsPath, `${binaryLaunchOptionsPath}.corrupt`)
            .pipe(Effect.ignore);
        }
        return yield* writeJsonFileAtomically(binaryLaunchOptionsPath, nextEntries ?? {}).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }),
    ).pipe(Effect.orElseSucceed(() => false));
  });

  const recordLegacyBaselines = Effect.fn("AcpRegistryCatalog.recordLegacyBaselines")(function* (
    inMemoryPrevious: AcpRegistryIndex | undefined,
    nextIndex: AcpRegistryIndex,
  ) {
    if (platformTarget === undefined) return true;
    const candidates = resolveAcpRegistryPlatformTargetCandidates(platformTarget);
    const readDiskPreviousIndex = Effect.fn("AcpRegistryCatalog.readDiskPreviousIndex")(
      function* () {
        return yield* fileSystem.readFileString(registryCachePath).pipe(
          Effect.flatMap((text) =>
            decodeRegistryText(text).pipe(
              Effect.map((index) => ({ status: "ok" as const, index })),
              Effect.orElseSucceed(() => ({ status: "missing" as const })),
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              error.reason._tag === "NotFound"
                ? ({ status: "missing" as const } as const)
                : ({ status: "io_error" as const } as const),
            ),
          ),
        );
      },
    );
    const readDirectoryOrMissing = (directory: string) =>
      fileSystem.readDirectory(directory).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed<Array<string>>([]),
        ),
      );
    const listSubdirectories = Effect.fn("AcpRegistryCatalog.listSubdirectories")(function* (
      directory: string,
    ) {
      const entries = yield* readDirectoryOrMissing(directory);
      const directories: Array<string> = [];
      for (const entry of entries) {
        const statResult = yield* fileSystem.stat(path.join(directory, entry)).pipe(
          Effect.map((info) => ({ status: "ok" as const, info })),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed({ status: "missing" as const }),
          ),
        );
        // Shared tools/ also holds non-directory files (e.g. tools/codex/active.json, .DS_Store).
        if (statResult.status === "ok" && statResult.info.type === "Directory") {
          directories.push(entry);
        }
      }
      return directories;
    });
    const scanAgentLegacySlots = Effect.fn("AcpRegistryCatalog.scanAgentLegacySlots")(function* (
      agentId: string,
    ) {
      const slots: Array<{
        readonly agentId: string;
        readonly encodedVersion: string;
        readonly candidateTarget: AcpRegistryPlatformTarget;
        readonly slotKey: string;
      }> = [];
      const agentRoot = path.join(installsDirectory, agentId);
      const agentStat = yield* fileSystem.stat(agentRoot).pipe(
        Effect.map((info) => ({ status: "ok" as const, info })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ status: "missing" as const }),
        ),
      );
      if (agentStat.status !== "ok" || agentStat.info.type !== "Directory") return slots;
      for (const encodedVersion of yield* listSubdirectories(agentRoot)) {
        const versionRoot = path.join(agentRoot, encodedVersion);
        for (const candidateTarget of candidates) {
          const installRoot = path.join(versionRoot, candidateTarget);
          const installStat = yield* fileSystem.stat(installRoot).pipe(
            Effect.map((info) => ({ status: "ok" as const, info })),
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed({ status: "missing" as const }),
            ),
          );
          if (installStat.status !== "ok" || installStat.info.type !== "Directory") continue;
          if (yield* fileSystem.exists(path.join(installRoot, BINARY_ARTIFACT_RECEIPT_FILENAME)))
            continue;
          slots.push({
            agentId,
            encodedVersion,
            candidateTarget,
            slotKey: legacyBaselineSlotKey(agentId, encodedVersion, candidateTarget),
          });
        }
      }
      return slots;
    });
    const scanUnreceiptedLegacySlots = Effect.fn("AcpRegistryCatalog.scanUnreceiptedLegacySlots")(
      function* (requiredAgentIds: ReadonlyArray<string>, includeExtraDirectories: boolean) {
        const slots: Array<{
          readonly agentId: string;
          readonly encodedVersion: string;
          readonly candidateTarget: AcpRegistryPlatformTarget;
          readonly slotKey: string;
        }> = [];
        const unscannedExtraAgents: Array<string> = [];
        for (const agentId of requiredAgentIds) {
          slots.push(...(yield* scanAgentLegacySlots(agentId)));
        }
        if (includeExtraDirectories) {
          // On corrupt-baselines rebuild, also discover readable removed-agent slots and record
          // an agent-level unknown sentinel for unreadable extra directories (such as unrelated
          // tools or temporarily unreadable removed agents) so normal refreshes stay isolated
          // without losing unknown provenance if a removed agent is later re-added.
          const requiredSet = new Set(requiredAgentIds);
          for (const entry of yield* listSubdirectories(installsDirectory)) {
            if (requiredSet.has(entry)) continue;
            const extraResult = yield* Effect.result(scanAgentLegacySlots(entry));
            if (Result.isSuccess(extraResult)) {
              slots.push(...extraResult.success);
            } else {
              unscannedExtraAgents.push(entry);
            }
          }
        }
        return { slots, unscannedExtraAgents };
      },
    );

    const installsStat = yield* fileSystem.stat(installsDirectory).pipe(
      Effect.map((info) => ({ status: "ok" as const, info })),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed({ status: "missing" as const }),
      ),
      Effect.orElseSucceed(() => ({ status: "io_error" as const })),
    );
    if (installsStat.status === "missing") {
      legacyBaselineDiscoveryIncomplete = false;
      return true;
    }
    if (installsStat.status === "io_error") {
      legacyBaselineDiscoveryIncomplete = true;
      yield* Effect.logDebug(
        "Could not inspect managed ACP binary directory for legacy baselines; keeping existing disk registry cache.",
      );
      return false;
    }

    const initialDisk = yield* readLegacyBaselinesFile(fileSystem, legacyBaselinesPath);
    const initialDiskIndex = yield* readDiskPreviousIndex();
    if (initialDiskIndex.status === "io_error") {
      legacyBaselineDiscoveryIncomplete = true;
      yield* Effect.logDebug(
        "Could not read cached ACP Registry index for legacy baselines; keeping existing disk registry cache.",
      );
      return false;
    }
    // Scope normal scans to ACP agent directories referenced by the previous/next index or
    // in-memory baselines so unrelated entries in shared tools/ never block registry refreshes.
    // Include extra directories (best-effort) only when rebuilding a corrupt baselines file.
    const requiredAgentIds = Array.from(
      new Set<string>([
        ...nextIndex.agents.map((agent) => agent.id),
        ...(initialDiskIndex.status === "ok"
          ? initialDiskIndex.index.agents.map((agent) => agent.id)
          : []),
        ...(inMemoryPrevious?.agents.map((agent) => agent.id) ?? []),
        ...Array.from(legacyBaselineBySlotKey.keys())
          .filter((key) => !key.endsWith("\0*"))
          .map((key) => key.split("\0")[0] ?? ""),
      ]),
    ).filter((id) => id.length > 0);
    const initialIncludedExtraDirs = initialDisk.status === "corrupt";
    const scanResult = yield* Effect.result(
      scanUnreceiptedLegacySlots(requiredAgentIds, initialIncludedExtraDirs),
    );
    if (Result.isFailure(scanResult)) {
      legacyBaselineDiscoveryIncomplete = true;
      yield* Effect.logDebug(
        "Could not scan managed ACP binary directories for legacy baselines; keeping existing disk registry cache.",
      );
      return false;
    }
    const { slots: unreceiptedLegacySlots, unscannedExtraAgents } = scanResult.success;
    if (unreceiptedLegacySlots.length === 0 && unscannedExtraAgents.length === 0) {
      legacyBaselineDiscoveryIncomplete = false;
      return true;
    }

    const recordDivergingInMemory = Effect.fn("AcpRegistryCatalog.recordDivergingLegacyBaselines")(
      function* (existingBaselines: Readonly<Record<string, string>>) {
        const unpersistedSlots = unreceiptedLegacySlots.filter((slot) => {
          const existingBaseline = existingBaselines[slot.slotKey];
          if (existingBaseline !== undefined) {
            legacyBaselineBySlotKey.set(slot.slotKey, existingBaseline);
            return false;
          }
          return true;
        });
        if (unpersistedSlots.length === 0) {
          return {
            newBaselines: {} as Record<string, string>,
            hasUpdates: false,
            readError: false,
          };
        }
        // Prefer the on-disk registry cache over in-memory state so a recovery refresh after a
        // previous skipped disk write still compares against the index persisted on disk.
        const diskIndexResult = yield* readDiskPreviousIndex();
        if (diskIndexResult.status === "io_error") {
          legacyBaselineDiscoveryIncomplete = true;
          return {
            newBaselines: {} as Record<string, string>,
            hasUpdates: false,
            readError: true,
          };
        }
        const previousIndex =
          diskIndexResult.status === "ok" ? diskIndexResult.index : inMemoryPrevious;
        const previousById = new Map(
          (previousIndex?.agents ?? []).map((agent) => [agent.id, agent] as const),
        );
        const nextById = new Map(nextIndex.agents.map((agent) => [agent.id, agent] as const));
        const newBaselines: Record<string, string> = {};
        let hasUpdates = false;
        for (const slot of unpersistedSlots) {
          const agentUnknownKey = legacyBaselineAgentUnknownKey(slot.agentId);
          if (
            existingBaselines[agentUnknownKey] === LEGACY_BASELINE_UNKNOWN ||
            legacyBaselineBySlotKey.get(agentUnknownKey) === LEGACY_BASELINE_UNKNOWN
          ) {
            legacyBaselineBySlotKey.set(slot.slotKey, LEGACY_BASELINE_UNKNOWN);
            newBaselines[slot.slotKey] = LEGACY_BASELINE_UNKNOWN;
            hasUpdates = true;
            continue;
          }
          const existingInMemory = legacyBaselineBySlotKey.get(slot.slotKey);
          if (existingInMemory !== undefined) {
            newBaselines[slot.slotKey] = existingInMemory;
            hasUpdates = true;
            continue;
          }
          const previousAgent = previousById.get(slot.agentId);
          if (
            previousAgent === undefined ||
            encodeURIComponent(previousAgent.version) !== slot.encodedVersion
          ) {
            continue;
          }
          const previousTarget = previousAgent.distribution.binary?.[slot.candidateTarget];
          if (previousTarget === undefined) continue;
          const previousKey = binaryArtifactIdentityKey(previousTarget);
          const nextAgent = nextById.get(slot.agentId);
          const nextTarget =
            nextAgent !== undefined && encodeURIComponent(nextAgent.version) === slot.encodedVersion
              ? nextAgent.distribution.binary?.[slot.candidateTarget]
              : undefined;
          // Record the legacy artifact whenever the slot's artifact changes, version bumps, or disappears
          // so a later rollback or repackage at the same version never mistakes the legacy install for it.
          if (nextTarget !== undefined && binaryArtifactIdentityKey(nextTarget) === previousKey) {
            continue;
          }
          legacyBaselineBySlotKey.set(slot.slotKey, previousKey);
          newBaselines[slot.slotKey] = previousKey;
          hasUpdates = true;
        }
        return { newBaselines, hasUpdates, readError: false };
      },
    );

    const preserveAndFail = Effect.fn("AcpRegistryCatalog.preserveLegacyBaselinesOnError")(
      function* (existingBaselines: Readonly<Record<string, string>>, reason: string) {
        yield* recordDivergingInMemory(existingBaselines);
        yield* Effect.logDebug(reason);
        return false;
      },
    );

    if (
      initialDisk.status === "ok" &&
      unreceiptedLegacySlots.every((slot) => initialDisk.baselines[slot.slotKey] !== undefined)
    ) {
      for (const slot of unreceiptedLegacySlots) {
        legacyBaselineBySlotKey.set(slot.slotKey, initialDisk.baselines[slot.slotKey]!);
      }
      legacyBaselineDiscoveryIncomplete = false;
      return true;
    }
    if (initialDisk.status === "io_error") {
      return yield* preserveAndFail(
        {},
        "Could not read ACP Registry legacy baselines; keeping existing disk registry cache.",
      );
    }

    return yield* withLegacyBaselinesLock((isLockOwned) =>
      Effect.gen(function* () {
        const disk = yield* readLegacyBaselinesFile(fileSystem, legacyBaselinesPath);
        if (disk.status === "io_error") {
          return yield* preserveAndFail(
            {},
            "Could not read ACP Registry legacy baselines; keeping existing disk registry cache.",
          );
        }
        let mergedBaselines: Record<string, string>;
        if (disk.status === "corrupt") {
          const corruptScan = initialIncludedExtraDirs
            ? { slots: unreceiptedLegacySlots, unscannedExtraAgents }
            : yield* Effect.result(scanUnreceiptedLegacySlots(requiredAgentIds, true)).pipe(
                Effect.map((result) => (Result.isSuccess(result) ? result.success : null)),
              );
          if (corruptScan === null) {
            legacyBaselineDiscoveryIncomplete = true;
            yield* Effect.logDebug(
              "Could not scan managed ACP binary directories while rebuilding corrupt legacy baselines; keeping existing disk registry cache.",
            );
            return false;
          }
          // Copy the corrupt bytes aside before atomically replacing legacy-baselines.json so there
          // is no missing-file window. Never reconstruct provenance from the unverified cached
          // registry index; preserve only baselines already verified in memory and mark others
          // unknown so resolve() requires a fresh receipted install.
          yield* fileSystem
            .copyFile(legacyBaselinesPath, `${legacyBaselinesPath}.corrupt`)
            .pipe(Effect.ignore);
          mergedBaselines = {};
          for (const slot of corruptScan.slots) {
            const baseline = legacyBaselineBySlotKey.get(slot.slotKey) ?? LEGACY_BASELINE_UNKNOWN;
            mergedBaselines[slot.slotKey] = baseline;
            legacyBaselineBySlotKey.set(slot.slotKey, baseline);
          }
          for (const unscannedAgentId of corruptScan.unscannedExtraAgents) {
            const unknownKey = legacyBaselineAgentUnknownKey(unscannedAgentId);
            mergedBaselines[unknownKey] = LEGACY_BASELINE_UNKNOWN;
            legacyBaselineBySlotKey.set(unknownKey, LEGACY_BASELINE_UNKNOWN);
          }
        } else {
          const { newBaselines, hasUpdates, readError } = yield* recordDivergingInMemory(
            disk.baselines,
          );
          if (readError) return false;
          if (!hasUpdates) {
            legacyBaselineDiscoveryIncomplete = false;
            return true;
          }
          mergedBaselines = { ...disk.baselines, ...newBaselines };
        }
        if (!(yield* isLockOwned)) {
          yield* Effect.logDebug(
            "Lost ACP Registry legacy baselines lock before writing; keeping existing disk registry cache.",
          );
          return false;
        }
        return yield* writeLegacyBaselinesAtomically(mergedBaselines).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              legacyBaselineDiscoveryIncomplete = false;
            }),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logDebug(
              "Could not persist ACP Registry legacy baselines; keeping existing disk registry cache.",
            ).pipe(Effect.as(false)),
          ),
        );
      }),
    ).pipe(
      Effect.catch(() =>
        preserveAndFail(
          initialDisk.status === "ok" ? initialDisk.baselines : {},
          "Could not lock ACP Registry legacy baselines; keeping existing disk registry cache.",
        ),
      ),
    );
  });

  const refreshRegistry = Effect.fn("AcpRegistryCatalog.refreshRegistry")(function* (options?: {
    readonly observedFetchRevision?: number;
    readonly observedAttemptRevision?: number;
    readonly failureBackoffMs?: number;
    readonly coalesceFailure?: boolean;
    readonly acceptAnyIndex?: boolean;
  }) {
    const initialState = yield* Ref.get(registryState);
    const startFetchRevision = options?.observedFetchRevision ?? initialState.fetchRevision;
    const startAttemptRevision = options?.observedAttemptRevision ?? initialState.attemptRevision;
    const failureBackoffMs = options?.failureBackoffMs;
    const coalesceFailure = options?.coalesceFailure ?? failureBackoffMs !== undefined;
    return yield* registrySemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(registryState);
        if (
          current.index !== undefined &&
          (options?.acceptAnyIndex === true ||
            current.fetchRevision !== startFetchRevision ||
            (failureBackoffMs !== undefined && current.attemptRevision !== startAttemptRevision))
        ) {
          return { index: current.index, indexRevision: current.indexRevision };
        }
        if (
          coalesceFailure &&
          current.index === undefined &&
          current.attemptRevision !== startAttemptRevision &&
          current.lastFailure !== undefined
        ) {
          return yield* current.lastFailure;
        }
        if (failureBackoffMs !== undefined && current.failedAtMs !== undefined) {
          const now = yield* Clock.currentTimeMillis;
          if (now >= current.failedAtMs && now - current.failedAtMs < failureBackoffMs) {
            if (current.index !== undefined) {
              return { index: current.index, indexRevision: current.indexRevision };
            }
            if (current.lastFailure !== undefined) {
              return yield* current.lastFailure;
            }
          }
        }

        const startInvalidationGeneration = current.invalidationGeneration;
        const result = yield* fetchRegistry().pipe(
          Effect.flatMap(({ registry, text }) =>
            recordLegacyBaselines(current.index, registry).pipe(
              Effect.flatMap((baselinesPersisted) =>
                baselinesPersisted ? writeRegistryCache(text) : Effect.void,
              ),
              Effect.as({ index: registry, refreshed: true as const }),
            ),
          ),
          Effect.catch((networkError) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.logDebug("ACP Registry index refresh failed", {
                reason: networkError.reason,
                stage: networkError.stage ?? "unknown",
              });
              // Prefer an already-loaded index over disk so a cache-write failure cannot regress it.
              const inMemory = (yield* Ref.get(registryState)).index;
              if (inMemory !== undefined) {
                return { index: inMemory, refreshed: false as const, failure: networkError };
              }
              const cached = yield* readCachedRegistry;
              if (Option.isSome(cached)) {
                return { index: cached.value, refreshed: false as const, failure: networkError };
              }
              yield* Ref.update(registryState, (state) =>
                state.invalidationGeneration === startInvalidationGeneration
                  ? {
                      ...state,
                      failedAtMs: now,
                      lastFailure: networkError,
                      attemptRevision: state.attemptRevision + 1,
                    }
                  : state,
              );
              return yield* networkError;
            }),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        const indexRevision = yield* Ref.modify(registryState, (state) => {
          const invalidatedDuringFetch =
            state.invalidationGeneration !== startInvalidationGeneration;
          const indexChanged =
            result.refreshed &&
            (state.index === undefined || !Equal.equals(result.index, state.index));
          const nextIndexRevision = indexChanged ? state.indexRevision + 1 : state.indexRevision;
          return [
            nextIndexRevision,
            {
              ...state,
              index: result.index,
              fetchedAtMs: result.refreshed && !invalidatedDuringFetch ? now : undefined,
              failedAtMs: !result.refreshed && !invalidatedDuringFetch ? now : undefined,
              lastFailure:
                !result.refreshed && !invalidatedDuringFetch ? result.failure : undefined,
              fetchRevision:
                result.refreshed && !invalidatedDuringFetch
                  ? state.fetchRevision + 1
                  : state.fetchRevision,
              attemptRevision: invalidatedDuringFetch
                ? state.attemptRevision
                : state.attemptRevision + 1,
              indexRevision: nextIndexRevision,
            },
          ] as const;
        });
        return { index: result.index, indexRevision };
      }),
    );
  });

  const recentRegistry = Effect.fn("AcpRegistryCatalog.recentRegistry")(function* (
    maxAgeMs = REGISTRY_SEARCH_MAX_AGE_MS,
    failureBackoffMs?: number,
  ) {
    const state = yield* Ref.get(registryState);
    const now = yield* Clock.currentTimeMillis;
    // A clock moved back makes the stamp untrustworthy, so it counts as stale.
    if (
      state.index !== undefined &&
      state.fetchedAtMs !== undefined &&
      now >= state.fetchedAtMs &&
      now - state.fetchedAtMs < maxAgeMs
    ) {
      return { index: state.index, indexRevision: state.indexRevision };
    }
    return yield* refreshRegistry({
      observedFetchRevision: state.fetchRevision,
      observedAttemptRevision: state.attemptRevision,
      ...(failureBackoffMs === undefined ? {} : { failureBackoffMs }),
    });
  });

  const refreshIndex: AcpRegistryCatalog["Service"]["refreshIndex"] = Effect.fn(
    "AcpRegistryCatalog.refreshIndex",
  )(function* ({ maxAgeMs, failureBackoffMs }) {
    const state = yield* Ref.get(registryState);
    const now = yield* Clock.currentTimeMillis;
    if (
      state.failedAtMs !== undefined &&
      now >= state.failedAtMs &&
      now - state.failedAtMs < failureBackoffMs
    ) {
      if (state.index !== undefined) return state.indexRevision;
      if (state.lastFailure !== undefined) return yield* state.lastFailure;
    }
    return (yield* recentRegistry(maxAgeMs, failureBackoffMs)).indexRevision;
  });

  const invalidateIndex: AcpRegistryCatalog["Service"]["invalidateIndex"] = Effect.fn(
    "AcpRegistryCatalog.invalidateIndex",
  )(function* () {
    yield* Ref.update(registryState, (state) => ({
      ...state,
      fetchedAtMs: undefined,
      failedAtMs: undefined,
      lastFailure: undefined,
      invalidationGeneration: state.invalidationGeneration + 1,
    }));
  });

  const loadRegistrySnapshot = Effect.fn("AcpRegistryCatalog.loadRegistry")(function* () {
    const current = yield* Ref.get(registryState);
    if (current.index !== undefined) {
      return { index: current.index, indexRevision: current.indexRevision };
    }

    const cached = yield* readCachedRegistry;
    if (Option.isNone(cached)) {
      return yield* refreshRegistry({ coalesceFailure: true, acceptAnyIndex: true });
    }
    // Publish without waiting on an in-flight refresh, while letting a completed refresh win.
    return yield* Ref.modify(registryState, (state) => {
      const index = state.index ?? cached.value;
      return [
        { index, indexRevision: state.indexRevision },
        state.index !== undefined ? state : { ...state, index },
      ] as const;
    });
  });

  const runCommand = Effect.fn("AcpRegistryCatalog.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeout?: Duration.Input;
      readonly timeoutReason?: AcpRegistryErrorReason;
      readonly nonZeroExitReason?: AcpRegistryErrorReason;
      readonly truncatedOutputReason?: AcpRegistryErrorReason;
      readonly maxStdoutBytes?: number;
    } = {},
  ) {
    const collect = Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(
        command,
        args,
        options.env === undefined ? {} : { env: options.env },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env === undefined ? {} : { env: options.env }),
          shell: resolved.shell,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES,
          }),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (tail, text) => `${tail}${text}`.slice(-MAX_COMMAND_ERROR_TAIL_CHARS),
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        return yield* new AcpRegistryError({
          reason: options.nonZeroExitReason ?? "install_failed",
          detail: `ACP Registry install command '${command}' exited with code ${Number(exitCode)}: ${stderr.trim()}`,
        });
      }
      // Truncated listings would bypass archive traversal validation.
      if (stdout.truncated) {
        return yield* new AcpRegistryError({
          reason: options.truncatedOutputReason ?? "archive_invalid",
          detail: `ACP Registry install command '${command}' produced more output than expected.`,
        });
      }
      return stdout.text;
    });
    const scoped = collect.pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not run ACP Registry install command '${command}'.`,
              cause,
            }),
      ),
    );
    return yield* options.timeout === undefined
      ? scoped
      : scoped.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              Effect.fail(
                new AcpRegistryError({
                  reason: options.timeoutReason ?? "install_failed",
                  detail: `Timed out running ACP Registry install command '${command}'.`,
                }),
              ),
          }),
        );
  });

  const packageReceiptPath = (agentId: string, distribution: "npx" | "uvx", managerPath: string) =>
    sha256Hex(new TextEncoder().encode(`${distribution}\0${managerPath}`)).pipe(
      Effect.map((digest) =>
        path.join(packageReceiptsDirectory, `${agentId}-${digest.slice(0, 16)}.json`),
      ),
    );

  const readPackageReceipt = Effect.fn("AcpRegistryCatalog.readPackageReceipt")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    managerPath: string,
  ) {
    const receipt = yield* fileSystem
      .readFileString(yield* packageReceiptPath(agent.id, distribution, managerPath))
      .pipe(
        Effect.map(decodePackageInstallReceipt),
        Effect.orElseSucceed(() => Option.none()),
      );
    if (
      Option.isNone(receipt) ||
      receipt.value.agentId !== agent.id ||
      receipt.value.agentVersion !== agent.version ||
      receipt.value.distribution !== distribution ||
      receipt.value.packageSpec !== packageSpec ||
      receipt.value.managerPath !== managerPath ||
      receipt.value.binDirectory !== packageBinDirectory(agent, distribution) ||
      path.dirname(receipt.value.executablePath) !== receipt.value.binDirectory
    ) {
      return Option.none<AcpRegistryPackageInstallReceipt>();
    }
    const executableExists = yield* fileSystem
      .exists(receipt.value.executablePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!executableExists) return Option.none<AcpRegistryPackageInstallReceipt>();

    if (distribution === "npx") {
      const packageIdentity = parseNpxPackageSpec(packageSpec);
      if (receipt.value.packageRoot === undefined || receipt.value.packageVersion === undefined) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const manifest = yield* fileSystem
        .readFileString(path.join(receipt.value.packageRoot, "package.json"))
        .pipe(Effect.flatMap(decodeNpmPackageManifest), Effect.option);
      if (
        Option.isNone(manifest) ||
        manifest.value.name !== packageIdentity.name ||
        manifest.value.version !== packageIdentity.version ||
        receipt.value.packageVersion !== packageIdentity.version
      ) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
    }
    return receipt;
  });

  const writePackageReceipt = Effect.fn("AcpRegistryCatalog.writePackageReceipt")(
    function* (receipt: AcpRegistryPackageInstallReceipt) {
      const receiptPath = yield* packageReceiptPath(
        receipt.agentId,
        receipt.distribution,
        receipt.managerPath,
      );
      const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
      yield* fileSystem.makeDirectory(packageReceiptsDirectory, { recursive: true });
      yield* fileSystem.remove(temporaryPath, { force: true });
      yield* fileSystem.writeFileString(temporaryPath, `${encodePackageInstallReceipt(receipt)}\n`);
      yield* fileSystem.remove(receiptPath, { force: true });
      yield* fileSystem.rename(temporaryPath, receiptPath);
    },
    Effect.mapError((cause) =>
      isAcpRegistryError(cause)
        ? cause
        : new AcpRegistryError({
            reason: "install_failed",
            detail: "Could not record the globally installed ACP Registry command.",
            cause,
          }),
    ),
  );

  const parsePackageManagerPath = Effect.fn("AcpRegistryCatalog.parsePackageManagerPath")(
    function* (managerPath: string, output: string) {
      const lines = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length !== 1 || !path.isAbsolute(lines[0]!)) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry package manager '${managerPath}' returned an invalid global path.`,
        });
      }
      return lines[0]!;
    },
  );

  const npmCommandName = (
    agent: AcpRegistryAgent,
    packageName: string,
    manifest: typeof NpmPackageManifest.Type,
  ): string | undefined => {
    const packageBaseName = packageName.split("/").pop() ?? packageName;
    if (typeof manifest.bin === "string") return packageBaseName;
    const entries = Object.entries(manifest.bin).toSorted(([left], [right]) =>
      compareText(left, right),
    );
    if (entries.length === 1) return entries[0]![0];
    if (manifest.bin[packageBaseName] !== undefined) return packageBaseName;
    if (manifest.bin[agent.id] !== undefined) return agent.id;
    return new Set(entries.map(([, commandPath]) => commandPath)).size === 1
      ? entries[0]?.[0]
      : undefined;
  };

  const discoverNpmGlobalPackage = Effect.fn("AcpRegistryCatalog.discoverNpmGlobalPackage")(
    function* (
      agent: AcpRegistryAgent,
      packageSpec: string,
      managerPath: string,
      environment: NodeJS.ProcessEnv,
    ) {
      const packageIdentity = parseNpxPackageSpec(packageSpec);
      const commandOptions = {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed" as const,
      } as const;
      const globalRoot = yield* runCommand(managerPath, ["root", "--global"], commandOptions).pipe(
        Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)),
      );
      const globalPrefix = yield* runCommand(
        managerPath,
        ["prefix", "--global"],
        commandOptions,
      ).pipe(Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)));
      const packageRoot = path.join(globalRoot, ...packageIdentity.name.split("/"));
      const manifestPath = path.join(packageRoot, "package.json");
      const manifestInfo = yield* fileSystem.stat(manifestPath).pipe(Effect.option);
      if (Option.isNone(manifestInfo) || manifestInfo.value.size > MAX_PACKAGE_MANIFEST_BYTES) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const manifest = yield* fileSystem
        .readFileString(manifestPath)
        .pipe(Effect.flatMap(decodeNpmPackageManifest), Effect.option);
      if (
        Option.isNone(manifest) ||
        manifest.value.name !== packageIdentity.name ||
        manifest.value.version !== packageIdentity.version
      ) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const commandName = npmCommandName(agent, packageIdentity.name, manifest.value);
      if (commandName === undefined) return Option.none<AcpRegistryPackageInstallReceipt>();
      const binDirectory = platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin");
      const executablePath = yield* resolveExecutable(
        path.join(binDirectory, commandName),
        environment,
      );
      return executablePath === undefined
        ? Option.none<AcpRegistryPackageInstallReceipt>()
        : Option.some<AcpRegistryPackageInstallReceipt>({
            agentId: agent.id,
            agentVersion: agent.version,
            distribution: "npx" as const,
            packageSpec,
            managerPath,
            binDirectory,
            executablePath,
            packageRoot,
            packageVersion: manifest.value.version,
          });
    },
  );

  const discoverUvGlobalPackage = Effect.fn("AcpRegistryCatalog.discoverUvGlobalPackage")(
    function* (
      agent: AcpRegistryAgent,
      packageSpec: string,
      managerPath: string,
      environment: NodeJS.ProcessEnv,
    ) {
      const packageIdentity = parseUvxPackageSpec(packageSpec);
      const installedTools = yield* runCommand(managerPath, ["tool", "list"], {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
      const normalizedPackageName = packageIdentity.name.toLowerCase().replace(/[._-]+/gu, "-");
      const exactVersionInstalled = installedTools.split(/\r?\n/u).some((line) => {
        const match = /^(\S+) v(\S+)(?:\s|$)/u.exec(line);
        return (
          match?.[1]?.toLowerCase().replace(/[._-]+/gu, "-") === normalizedPackageName &&
          match[2] === packageIdentity.version
        );
      });
      if (!exactVersionInstalled) return Option.none<AcpRegistryPackageInstallReceipt>();
      const binDirectory = yield* runCommand(managerPath, ["tool", "dir", "--bin"], {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed",
      }).pipe(Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)));
      const managedBinEnvironment = { ...environment, PATH: binDirectory };
      let executablePath: string | undefined;
      for (const candidate of packageCommandCandidates(agent, packageIdentity.name)) {
        executablePath = yield* resolveExecutable(candidate, managedBinEnvironment);
        if (executablePath !== undefined) break;
      }
      return executablePath === undefined
        ? Option.none<AcpRegistryPackageInstallReceipt>()
        : Option.some<AcpRegistryPackageInstallReceipt>({
            agentId: agent.id,
            agentVersion: agent.version,
            distribution: "uvx" as const,
            packageSpec,
            managerPath,
            binDirectory,
            executablePath,
            packageVersion: packageIdentity.version,
          });
    },
  );

  const ensureGlobalPackage = Effect.fn("AcpRegistryCatalog.ensureGlobalPackage")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const managerName = packageManagerFor(distribution)!;
    const managerPath = yield* resolveExecutable(managerName, environment);
    if (managerPath === undefined) {
      return yield* new AcpRegistryError({
        reason: "runner_unavailable",
        detail: `ACP Registry agent ${agent.id} requires '${managerName}', but it is not available on this environment's PATH.`,
      });
    }
    const receipt = yield* readPackageReceipt(agent, distribution, packageSpec, managerPath);
    if (Option.isSome(receipt) && distribution === "npx") return receipt.value;

    const packageRoot = packageInstallRoot(agent, distribution);
    yield* fileSystem.makeDirectory(packageRoot, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not create the managed install directory for ${agent.id}.`,
            cause,
          }),
      ),
    );
    const packageEnvironment =
      distribution === "npx"
        ? { ...withoutNpmPrefix(environment, platform), npm_config_prefix: packageRoot }
        : {
            ...environment,
            UV_TOOL_DIR: packageRoot,
            UV_TOOL_BIN_DIR: packageBinDirectory(agent, distribution),
          };
    if (Option.isSome(receipt)) {
      const installed = yield* discoverUvGlobalPackage(
        agent,
        packageSpec,
        managerPath,
        packageEnvironment,
      );
      if (Option.isSome(installed)) return installed.value;
    }

    const discover =
      distribution === "npx"
        ? () => discoverNpmGlobalPackage(agent, packageSpec, managerPath, packageEnvironment)
        : () => discoverUvGlobalPackage(agent, packageSpec, managerPath, packageEnvironment);
    const existing = yield* discover();
    if (Option.isSome(existing)) {
      yield* writePackageReceipt(existing.value);
      return existing.value;
    }

    const managerDirectory = yield* managerBinDirectory(managerPath);
    const installEnvironment = withPreferredPath(packageEnvironment, managerDirectory, platform);
    if (distribution === "npx") {
      yield* runCommand(managerPath, ["install", "--global", packageSpec], {
        env: installEnvironment,
        timeout: PACKAGE_INSTALL_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
    } else {
      yield* runCommand(managerPath, ["tool", "install", "--force", packageSpec], {
        env: installEnvironment,
        timeout: PACKAGE_INSTALL_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
    }

    if (distribution === "npx") {
      const installed = yield* discoverNpmGlobalPackage(
        agent,
        packageSpec,
        managerPath,
        packageEnvironment,
      );
      if (Option.isNone(installed)) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry installed ${packageSpec}, but could not resolve its global command.`,
        });
      }
      yield* writePackageReceipt(installed.value);
      return installed.value;
    }

    const installed = yield* discoverUvGlobalPackage(
      agent,
      packageSpec,
      managerPath,
      packageEnvironment,
    );
    if (Option.isNone(installed)) {
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: `ACP Registry installed ${packageSpec}, but could not resolve its global command.`,
      });
    }
    yield* writePackageReceipt(installed.value);
    return installed.value;
  });

  const assertExecutableInRoot = Effect.fn("AcpRegistryCatalog.assertExecutableInRoot")(function* (
    root: string,
    executablePath: string,
    options?: { readonly makeExecutable?: boolean },
  ) {
    const rootRealPath = yield* fileSystem.realPath(root);
    const executableRealPath = yield* fileSystem.realPath(executablePath);
    const relative = path.relative(rootRealPath, executableRealPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command resolves outside its installation directory.",
      });
    }
    // chmod follows symlinks, so only change the mode once the real path is known to be inside.
    if (options?.makeExecutable && platform !== "win32") {
      yield* fileSystem.chmod(executableRealPath, 0o755);
    }
    const info = yield* fileSystem.stat(executableRealPath);
    const hasExecutableMode = platform === "win32" || (info.mode & 0o111) !== 0;
    if (info.type !== "File" || !hasExecutableMode) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command is not a regular executable file.",
      });
    }
    return executableRealPath;
  });

  const binaryPaths = (agent: AcpRegistryAgent, target: typeof AcpRegistryBinaryTarget.Type) => {
    const commandSegments = normalizeRegistryCommandPath(target.cmd);
    const matchedPlatformTarget =
      resolveAcpRegistryPlatformTargetCandidates(platformTarget).find(
        (candidate) => agent.distribution.binary?.[candidate] === target,
      ) ?? platformTarget;
    if (matchedPlatformTarget === undefined || commandSegments === undefined) return undefined;
    const versionRoot = agentInstallRoot(agent);
    const installRoot = path.join(versionRoot, matchedPlatformTarget);
    const artifactRoot = path.join(
      versionRoot,
      binaryArtifactDirName(matchedPlatformTarget, target),
    );
    return {
      commandSegments,
      installRoot,
      artifactRoot,
      platformTarget: matchedPlatformTarget,
      slotKey: legacyBaselineSlotKey(
        agent.id,
        encodeURIComponent(agent.version),
        matchedPlatformTarget,
      ),
      executablePath: path.join(installRoot, ...commandSegments),
      artifactExecutablePath: path.join(artifactRoot, ...commandSegments),
    };
  };

  const hasInstalledBinaryVersion = Effect.fn("AcpRegistryCatalog.hasInstalledBinaryVersion")(
    function* (agentId: string) {
      const agentRoot = path.join(installsDirectory, agentId);
      const versions = yield* fileSystem
        .readDirectory(agentRoot)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const version of versions) {
        const entries = yield* fileSystem
          .readDirectory(path.join(agentRoot, version))
          .pipe(Effect.orElseSucceed((): Array<string> => []));
        for (const candidateTarget of resolveAcpRegistryPlatformTargetCandidates(platformTarget)) {
          if (entries.some((entry) => isBinaryPlatformEntry(entry, candidateTarget))) {
            return true;
          }
        }
      }
      return false;
    },
  );

  const readMatchingBinaryReceipt = Effect.fn("AcpRegistryCatalog.readMatchingBinaryReceipt")(
    function* (root: string, executablePath: string, target: typeof AcpRegistryBinaryTarget.Type) {
      if (!(yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false)))) {
        return Option.none<AcpRegistryBinaryArtifactReceipt>();
      }
      const receiptPath = path.join(root, BINARY_ARTIFACT_RECEIPT_FILENAME);
      const rawReceipt = yield* fileSystem.readFileString(receiptPath).pipe(Effect.option);
      const decoded = Option.flatMap(rawReceipt, decodeBinaryArtifactReceipt);
      return Option.isSome(decoded) && binaryArtifactReceiptMatches(decoded.value, target)
        ? Option.some(decoded.value)
        : Option.none<AcpRegistryBinaryArtifactReceipt>();
    },
  );

  const isLegacyBinarySlotEligible = Effect.fn("AcpRegistryCatalog.isLegacyBinarySlotEligible")(
    function* (
      paths: NonNullable<ReturnType<typeof binaryPaths>>,
      target: typeof AcpRegistryBinaryTarget.Type,
    ) {
      if (
        !(yield* fileSystem.exists(paths.executablePath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return false;
      }
      const versionRoot = path.dirname(paths.installRoot);
      const versionEntries = yield* fileSystem
        .readDirectory(versionRoot)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const entry of versionEntries) {
        if (!isBinaryPlatformEntry(entry, paths.platformTarget)) continue;
        if (
          yield* fileSystem
            .exists(path.join(versionRoot, entry, BINARY_ARTIFACT_RECEIPT_FILENAME))
            .pipe(Effect.orElseSucceed(() => false))
        ) {
          return false;
        }
      }
      const currentKey = binaryArtifactIdentityKey(target);
      const agentUnknownKey = legacyBaselineAgentUnknownKey(paths.slotKey.split("\0")[0] ?? "");
      const memoryBaseline = legacyBaselineBySlotKey.get(paths.slotKey);
      if (memoryBaseline !== undefined) {
        return memoryBaseline === currentKey;
      }
      if (legacyBaselineBySlotKey.get(agentUnknownKey) === LEGACY_BASELINE_UNKNOWN) {
        return false;
      }
      const diskResult = yield* readLegacyBaselinesFile(fileSystem, legacyBaselinesPath);
      if (diskResult.status !== "ok") {
        return false;
      }
      const diskBaseline = diskResult.baselines[paths.slotKey];
      if (diskBaseline === undefined) {
        if (diskResult.baselines[agentUnknownKey] === LEGACY_BASELINE_UNKNOWN) {
          legacyBaselineBySlotKey.set(agentUnknownKey, LEGACY_BASELINE_UNKNOWN);
          return false;
        }
        return !legacyBaselineDiscoveryIncomplete;
      }
      legacyBaselineBySlotKey.set(paths.slotKey, diskBaseline);
      return diskBaseline === currentKey;
    },
  );

  const findMatchingBinarySlot = Effect.fn("AcpRegistryCatalog.findMatchingBinarySlot")(function* (
    paths: NonNullable<ReturnType<typeof binaryPaths>>,
    target: typeof AcpRegistryBinaryTarget.Type,
  ) {
    const artifactReceipt = yield* readMatchingBinaryReceipt(
      paths.artifactRoot,
      paths.artifactExecutablePath,
      target,
    );
    if (Option.isSome(artifactReceipt)) {
      return Option.some({
        root: paths.artifactRoot,
        executablePath: paths.artifactExecutablePath,
        receipt: artifactReceipt.value,
      });
    }
    const primaryReceipt = yield* readMatchingBinaryReceipt(
      paths.installRoot,
      paths.executablePath,
      target,
    );
    if (Option.isSome(primaryReceipt)) {
      return Option.some({
        root: paths.installRoot,
        executablePath: paths.executablePath,
        receipt: primaryReceipt.value,
      });
    }
    if (yield* isLegacyBinarySlotEligible(paths, target)) {
      return Option.some({
        root: paths.installRoot,
        executablePath: paths.executablePath,
      });
    }
    return Option.none<{
      readonly root: string;
      readonly executablePath: string;
      readonly receipt?: AcpRegistryBinaryArtifactReceipt;
    }>();
  });

  const syncReceiptLaunchOptions = Effect.fn("AcpRegistryCatalog.syncReceiptLaunchOptions")(
    function* (
      slot: {
        readonly root: string;
        readonly receipt?: AcpRegistryBinaryArtifactReceipt;
      },
      agent: AcpRegistryAgent,
      target: typeof AcpRegistryBinaryTarget.Type,
    ) {
      if (slot.receipt === undefined) return;
      const initialReceipt = slot.receipt;
      const hasSidecar = yield* fileSystem
        .exists(binaryLaunchOptionsPath)
        .pipe(Effect.orElseSucceed(() => false));
      const pendingEntry = pendingLaunchOptionsBySlotRoot.get(slot.root);
      const hasMatchingPending =
        pendingEntry !== undefined && receiptMatchesInstall(pendingEntry.receipt, initialReceipt);
      const receiptRev = initialReceipt.launchOptionsRevision ?? 0;
      let fastPathSidecarReadOk = false;
      let observedDiskRev = 0;
      let observedDiskRecoveryId: string | null = null;
      if (!hasSidecar) {
        fastPathSidecarReadOk = true;
        if (!hasMatchingPending && receiptMatchesLaunchOptions(initialReceipt, target)) {
          return;
        }
      } else {
        const diskResult = yield* readBinaryLaunchOptionsFile(fileSystem, binaryLaunchOptionsPath);
        if (diskResult.status === "ok") {
          fastPathSidecarReadOk = true;
          const diskStored = diskResult.entries[slot.root];
          const diskMatches = receiptMatchesInstall(diskStored, initialReceipt);
          observedDiskRev = diskMatches ? (diskStored.launchOptionsRevision ?? 0) : 0;
          observedDiskRecoveryId = diskMatches
            ? (diskStored.launchOptionsRecoveryId ?? null)
            : null;
          if (!hasMatchingPending) {
            if (diskStored === undefined && receiptMatchesLaunchOptions(initialReceipt, target)) {
              return;
            }
            if (
              diskMatches &&
              observedDiskRev > receiptRev &&
              receiptMatchesLaunchOptions(diskStored, target)
            ) {
              return;
            }
          }
        }
      }

      const receiptPath = path.join(slot.root, BINARY_ARTIFACT_RECEIPT_FILENAME);
      type PendingBase = {
        readonly baseReceiptRevision: number;
        readonly baseDurableRevision: number;
        readonly baseRecoveryId: string | null;
      };
      const buildLaunchOptionsReceipt = (
        baseReceipt: AcpRegistryBinaryArtifactReceipt,
        revision?: number,
        recoveryId?: string | null,
      ): AcpRegistryBinaryArtifactReceipt => ({
        version: agent.version,
        archive: target.archive,
        cmd: target.cmd,
        sha256: target.sha256 ?? null,
        ...(target.args && target.args.length > 0 ? { args: [...target.args] } : {}),
        ...(target.env && Object.keys(target.env).length > 0 ? { env: { ...target.env } } : {}),
        ...(revision !== undefined ? { launchOptionsRevision: revision } : {}),
        ...(recoveryId ? { launchOptionsRecoveryId: recoveryId } : {}),
        ...(baseReceipt.installId !== undefined ? { installId: baseReceipt.installId } : {}),
      });
      const recordPending = (baseReceipt: AcpRegistryBinaryArtifactReceipt, base: PendingBase) => {
        pendingLaunchOptionsBySlotRoot.set(slot.root, {
          ...base,
          receipt: buildLaunchOptionsReceipt(baseReceipt),
        });
      };
      // Keep baseDurableRevision and baseRecoveryId paired from the same observation/chain so a
      // pre-repair sidecar revision never gates a newer receipt or post-repair sidecar chain.
      const resolvePendingBaseOnUnreadableSidecar = (
        baseReceiptRev: number,
        priorPending: PendingBase | undefined,
      ): PendingBase => {
        if (fastPathSidecarReadOk && observedDiskRev > baseReceiptRev) {
          return {
            baseReceiptRevision: baseReceiptRev,
            baseDurableRevision: observedDiskRev,
            baseRecoveryId: observedDiskRecoveryId,
          };
        }
        if (priorPending !== undefined && baseReceiptRev <= priorPending.baseReceiptRevision) {
          return priorPending;
        }
        return {
          baseReceiptRevision: baseReceiptRev,
          baseDurableRevision: baseReceiptRev,
          baseRecoveryId: null,
        };
      };
      const recordPendingForInitialReceipt = () => {
        const currentPending = pendingLaunchOptionsBySlotRoot.get(slot.root);
        const matchingPending =
          currentPending !== undefined &&
          receiptMatchesInstall(currentPending.receipt, initialReceipt)
            ? currentPending
            : undefined;
        recordPending(
          initialReceipt,
          resolvePendingBaseOnUnreadableSidecar(
            receiptRev,
            matchingPending ?? (hasMatchingPending ? pendingEntry : undefined),
          ),
        );
      };
      yield* withBinaryLaunchOptionsLock((isLockOwned) =>
        Effect.gen(function* () {
          const freshReceiptRead = yield* Effect.result(fileSystem.readFileString(receiptPath));
          if (Result.isFailure(freshReceiptRead)) {
            if (freshReceiptRead.failure.reason._tag === "NotFound") {
              pendingLaunchOptionsBySlotRoot.delete(slot.root);
            } else {
              recordPendingForInitialReceipt();
            }
            return;
          }
          const decodedFreshReceipt = decodeBinaryArtifactReceipt(freshReceiptRead.success);
          if (
            Option.isNone(decodedFreshReceipt) ||
            !receiptMatchesInstall(decodedFreshReceipt.value, initialReceipt)
          ) {
            pendingLaunchOptionsBySlotRoot.delete(slot.root);
            return;
          }
          const freshReceipt = decodedFreshReceipt.value;
          const freshReceiptRev = freshReceipt.launchOptionsRevision ?? 0;
          const currentPending = pendingLaunchOptionsBySlotRoot.get(slot.root);
          const matchingPending =
            currentPending !== undefined &&
            receiptMatchesInstall(currentPending.receipt, freshReceipt)
              ? currentPending
              : undefined;
          const diskResult = yield* readBinaryLaunchOptionsFile(
            fileSystem,
            binaryLaunchOptionsPath,
          );
          if (diskResult.status === "io_error") {
            // Never treat an unreadable sidecar as absent or allocate below it; keep the target
            // pending until the sidecar can be read and reconciled under the lock.
            recordPending(
              freshReceipt,
              resolvePendingBaseOnUnreadableSidecar(freshReceiptRev, matchingPending),
            );
            return;
          }
          const isCorrupt = diskResult.status === "corrupt";
          const diskEntries = isCorrupt ? {} : diskResult.entries;
          const diskStored = diskEntries[slot.root];
          const diskMatches = receiptMatchesInstall(diskStored, freshReceipt);
          const freshDiskRev = diskMatches ? (diskStored.launchOptionsRevision ?? 0) : 0;
          const sidecarIsAuthoritative =
            !isCorrupt && diskMatches && freshDiskRev > freshReceiptRev;
          const currentSidecarRecoveryId = sidecarIsAuthoritative
            ? (diskStored.launchOptionsRecoveryId ?? null)
            : null;
          if (!isCorrupt && receiptMatchesLaunchOptions(freshReceipt, target)) {
            if (diskStored === undefined) {
              pendingLaunchOptionsBySlotRoot.delete(slot.root);
              return;
            }
            if (freshDiskRev <= freshReceiptRev) {
              pendingLaunchOptionsBySlotRoot.delete(slot.root);
              if (!(yield* isLockOwned)) return;
              const { [slot.root]: _removed, ...rest } = diskEntries;
              yield* writeJsonFileAtomically(binaryLaunchOptionsPath, rest).pipe(Effect.ignore);
              return;
            }
          }
          if (
            diskMatches &&
            freshDiskRev > freshReceiptRev &&
            receiptMatchesLaunchOptions(diskStored, target)
          ) {
            pendingLaunchOptionsBySlotRoot.delete(slot.root);
            return;
          }
          const allocationBaseRev = Math.max(
            freshReceiptRev,
            observedDiskRev,
            freshDiskRev,
            matchingPending?.baseDurableRevision ?? 0,
          );
          const nextRevision = allocationBaseRev + 1;
          const lockedPendingBase = (): PendingBase =>
            sidecarIsAuthoritative
              ? {
                  baseReceiptRevision: freshReceiptRev,
                  baseDurableRevision: freshDiskRev,
                  baseRecoveryId: currentSidecarRecoveryId,
                }
              : {
                  baseReceiptRevision: freshReceiptRev,
                  baseDurableRevision: freshReceiptRev,
                  baseRecoveryId: null,
                };
          if (!(yield* isLockOwned)) {
            if (isCorrupt && receiptMatchesLaunchOptions(freshReceipt, target)) {
              pendingLaunchOptionsBySlotRoot.delete(slot.root);
            } else {
              recordPending(freshReceipt, lockedPendingBase());
            }
            return;
          }
          const receiptWrite = yield* Effect.result(
            random.uuidV4().pipe(
              Effect.flatMap((id) => {
                const temporaryPath = `${receiptPath}.${process.pid}-${id}.tmp`;
                return fileSystem
                  .writeFileString(
                    temporaryPath,
                    encodeBinaryArtifactReceipt(agent, target, {
                      launchOptionsRevision: nextRevision,
                      ...(freshReceipt.installId !== undefined
                        ? { installId: freshReceipt.installId }
                        : {}),
                    }),
                  )
                  .pipe(
                    Effect.andThen(fileSystem.rename(temporaryPath, receiptPath)),
                    Effect.ensuring(
                      fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
                    ),
                  );
              }),
            ),
          );
          if (Result.isSuccess(receiptWrite)) {
            pendingLaunchOptionsBySlotRoot.delete(slot.root);
            if (isCorrupt || diskStored !== undefined) {
              if (!(yield* isLockOwned)) return;
              if (isCorrupt) {
                yield* fileSystem
                  .copyFile(binaryLaunchOptionsPath, `${binaryLaunchOptionsPath}.corrupt`)
                  .pipe(Effect.ignore);
              }
              const { [slot.root]: _removed, ...rest } = diskEntries;
              yield* writeJsonFileAtomically(binaryLaunchOptionsPath, rest).pipe(Effect.ignore);
            }
            return;
          }
          // If updating the receipt inside tools/ failed (e.g., read-only install directory or file
          // lock), persist the updated launch options in registry cache storage so fallback still
          // restores the last-resolved args and env even across restarts.
          if (!(yield* isLockOwned)) {
            if (isCorrupt && receiptMatchesLaunchOptions(freshReceipt, target)) {
              pendingLaunchOptionsBySlotRoot.delete(slot.root);
            } else {
              recordPending(freshReceipt, lockedPendingBase());
            }
            return;
          }
          if (isCorrupt) {
            yield* fileSystem
              .copyFile(binaryLaunchOptionsPath, `${binaryLaunchOptionsPath}.corrupt`)
              .pipe(Effect.ignore);
          }
          // Stamp a fresh recovery ID whenever starting a new sidecar chain (including after
          // corrupt repair by this or any other slot) so older higher-base pending options yield.
          const nextSidecarRecoveryId =
            sidecarIsAuthoritative && currentSidecarRecoveryId !== null
              ? currentSidecarRecoveryId
              : yield* random.uuidV4();
          const updatedSidecarReceipt = buildLaunchOptionsReceipt(
            freshReceipt,
            nextRevision,
            nextSidecarRecoveryId,
          );
          const sidecarWrite = yield* Effect.result(
            writeJsonFileAtomically(binaryLaunchOptionsPath, {
              ...diskEntries,
              [slot.root]: updatedSidecarReceipt,
            }),
          );
          if (Result.isSuccess(sidecarWrite)) {
            pendingLaunchOptionsBySlotRoot.delete(slot.root);
          } else if (isCorrupt && receiptMatchesLaunchOptions(freshReceipt, target)) {
            pendingLaunchOptionsBySlotRoot.delete(slot.root);
          } else {
            recordPending(freshReceipt, lockedPendingBase());
          }
        }),
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            recordPendingForInitialReceipt();
          }),
        ),
      );
    },
  );

  const installBinary = Effect.fn("AcpRegistryCatalog.installBinary")(function* (
    agent: AcpRegistryAgent,
    target: typeof AcpRegistryBinaryTarget.Type,
  ) {
    if (platformTarget === undefined) {
      return yield* new AcpRegistryError({
        reason: "unsupported_platform",
        detail: `ACP Registry does not support platform ${platform}-${architecture}.`,
      });
    }
    const paths = binaryPaths(agent, target);
    if (paths === undefined) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: `ACP Registry agent ${agent.id} declares an unsafe command path '${target.cmd}'.`,
      });
    }
    const { commandSegments, installRoot, artifactRoot } = paths;
    const validateCachedSlot = (slot: {
      readonly root: string;
      readonly executablePath: string;
      readonly receipt?: AcpRegistryBinaryArtifactReceipt;
    }) =>
      assertExecutableInRoot(slot.root, slot.executablePath).pipe(
        Effect.tap(() => syncReceiptLaunchOptions(slot, agent, target)),
        Effect.mapError(
          (cause) =>
            new AcpRegistryError({
              reason: "install_failed",
              detail: isAcpRegistryError(cause)
                ? cause.detail
                : `Could not validate cached ACP Registry agent ${agent.id}.`,
              cause,
            }),
        ),
      );
    const cachedSlot = yield* findMatchingBinarySlot(paths, target);
    if (Option.isSome(cachedSlot)) {
      return yield* validateCachedSlot(cachedSlot.value);
    }

    yield* fileSystem.makeDirectory(path.dirname(installRoot), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not create ACP Registry cache for ${agent.id}.`,
            cause,
          }),
      ),
    );
    const lockPath = `${installRoot}.lock`;

    return yield* withFileLock(lockPath, () =>
      Effect.gen(function* () {
        const lockedSlot = yield* findMatchingBinarySlot(paths, target);
        if (Option.isSome(lockedSlot)) {
          return yield* validateCachedSlot(lockedSlot.value);
        }
        const primaryExists = yield* fileSystem
          .exists(installRoot)
          .pipe(Effect.orElseSucceed(() => false));
        // Keep an existing primary directory intact for active sessions (and Windows file locks)
        // by installing same-version replacements into an immutable artifact-scoped sibling slot.
        const destinationRoot = primaryExists ? artifactRoot : installRoot;
        const destinationExecutable = path.join(destinationRoot, ...commandSegments);
        const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
          directory: path.dirname(installRoot),
          prefix: `.${agent.id}-install-`,
        });
        if (
          destinationRoot === artifactRoot &&
          (yield* fileSystem.exists(artifactRoot).pipe(Effect.orElseSucceed(() => false)))
        ) {
          // Under a freshly acquired lock after findMatchingBinarySlot returned None, an existing
          // artifactRoot is a broken/incomplete slot (e.g., deleted executable). Move it aside
          // before downloading; fail fast if moving fails (e.g., locked files on Windows) instead
          // of wasting a full archive download.
          yield* fileSystem
            .rename(artifactRoot, path.join(temporaryRoot, "replaced-broken-slot"))
            .pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.void,
              ),
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not replace broken ACP Registry install slot for ${agent.id}.`,
                    cause,
                  }),
              ),
            );
        }
        const extractionRoot = path.join(temporaryRoot, "extracted");
        yield* fileSystem.makeDirectory(extractionRoot, { recursive: true });
        const kind = archiveKind(target.archive);
        const archivePath = path.join(temporaryRoot, archiveFileName(kind));
        const response = yield* httpClient.execute(HttpClientRequest.get(target.archive)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(
            (cause) =>
              new AcpRegistryError({
                reason: "download_failed",
                detail: `Could not download ACP Registry agent ${agent.id} ${agent.version}.`,
                cause,
              }),
          ),
          Effect.timeoutOrElse({
            duration: ARCHIVE_REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new AcpRegistryError({
                  reason: "download_failed",
                  detail: `Timed out downloading ACP Registry agent ${agent.id} ${agent.version}.`,
                }),
              ),
          }),
        );
        // Stream hashes to avoid buffering large archives; Effect Crypto requires a whole buffer.
        const hash = sha256.create();
        let downloadedBytes = 0;
        yield* response.stream.pipe(
          Stream.tap((chunk) => {
            if (downloadedBytes + chunk.byteLength > MAX_ARCHIVE_BYTES) {
              return Effect.fail(
                new AcpRegistryError({
                  reason: "archive_invalid",
                  detail: `ACP Registry agent ${agent.id} archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`,
                }),
              );
            }
            downloadedBytes += chunk.byteLength;
            hash.update(chunk);
            return Effect.void;
          }),
          Stream.run(fileSystem.sink(archivePath)),
          Effect.mapError((cause) =>
            isAcpRegistryError(cause)
              ? cause
              : new AcpRegistryError({
                  reason: "download_failed",
                  detail: `Could not save ACP Registry agent ${agent.id} ${agent.version}.`,
                  cause,
                }),
          ),
          Effect.timeoutOrElse({
            duration: ARCHIVE_REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new AcpRegistryError({
                  reason: "download_failed",
                  detail: `Timed out reading ACP Registry agent ${agent.id} download.`,
                }),
              ),
          }),
        );
        if (target.sha256 !== undefined) {
          const actual = Hex.encode(hash.digest());
          if (actual !== target.sha256.toLowerCase()) {
            return yield* new AcpRegistryError({
              reason: "checksum_mismatch",
              detail: `ACP Registry agent ${agent.id} download did not match its declared SHA-256.`,
            });
          }
        }

        if (kind === "raw") {
          const targetPath = path.join(extractionRoot, ...commandSegments);
          yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
          yield* fileSystem.rename(archivePath, targetPath);
        } else {
          const tarCommand =
            platformTarget === "windows-aarch64" &&
            paths.platformTarget === "windows-x86_64" &&
            kind === "zip"
              ? cliArchiveTarCommand(platform, hostEnvironment)
              : "tar";
          const listArgs =
            kind === "tar_gz"
              ? ["-tzf", archivePath]
              : kind === "tar_bz2"
                ? ["-tjf", archivePath]
                : platform === "win32"
                  ? ["-tf", archivePath]
                  : undefined;
          const listingOptions = {
            maxStdoutBytes: MAX_ARCHIVE_LISTING_BYTES,
            timeout: ARCHIVE_EXTRACT_TIMEOUT,
            timeoutReason: "archive_invalid",
            nonZeroExitReason: "archive_invalid",
          } as const;
          const extractOptions = {
            timeout: ARCHIVE_EXTRACT_TIMEOUT,
            timeoutReason: "archive_invalid",
            nonZeroExitReason: "archive_invalid",
          } as const;
          const entries =
            listArgs === undefined
              ? yield* runCommand("unzip", ["-Z1", archivePath], listingOptions)
              : yield* runCommand(tarCommand, listArgs, listingOptions);
          if (!validateArchiveEntries(entries)) {
            return yield* new AcpRegistryError({
              reason: "archive_invalid",
              detail: `ACP Registry agent ${agent.id} archive contains an unsafe path.`,
            });
          }
          if (kind === "zip" && platform !== "win32") {
            yield* runCommand("unzip", ["-q", archivePath, "-d", extractionRoot], extractOptions);
          } else {
            const extractFlag = kind === "tar_gz" ? "-xzf" : kind === "tar_bz2" ? "-xjf" : "-xf";
            yield* runCommand(
              tarCommand,
              [extractFlag, archivePath, "-C", extractionRoot],
              extractOptions,
            );
          }
        }

        const stagedExecutable = path.join(extractionRoot, ...commandSegments);
        if (!(yield* fileSystem.exists(stagedExecutable).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new AcpRegistryError({
            reason: "archive_invalid",
            detail: `ACP Registry archive for ${agent.id} did not contain '${target.cmd}'.`,
          });
        }
        yield* assertExecutableInRoot(extractionRoot, stagedExecutable, { makeExecutable: true });
        // Stamp a fresh installId so stale in-memory or sidecar launch options from any prior
        // broken install at destinationRoot can never match or outrank the new receipt.
        const installId = yield* random.uuidV4();
        yield* fileSystem
          .writeFileString(
            path.join(extractionRoot, BINARY_ARTIFACT_RECEIPT_FILENAME),
            encodeBinaryArtifactReceipt(agent, target, { installId }),
            { flag: "wx" },
          )
          .pipe(
            Effect.mapError((cause) =>
              isAlreadyExists(cause)
                ? new AcpRegistryError({
                    reason: "archive_invalid",
                    detail: `ACP Registry archive for ${agent.id} contains a reserved '${BINARY_ARTIFACT_RECEIPT_FILENAME}' entry.`,
                    cause,
                  })
                : new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not write ACP Registry artifact receipt for ${agent.id}.`,
                    cause,
                  }),
            ),
          );
        // Recheck right before promotion in case a stale-lock takeover let another installer publish
        // a valid receipt-matching slot while this staging download was in flight. Never remove an
        // existing destinationRoot before rename so a concurrent publisher's directory cannot be deleted.
        const concurrentSlot = yield* findMatchingBinarySlot(paths, target);
        if (Option.isSome(concurrentSlot)) {
          const validated = yield* assertExecutableInRoot(
            concurrentSlot.value.root,
            concurrentSlot.value.executablePath,
          ).pipe(Effect.option);
          if (Option.isSome(validated)) {
            return validated.value;
          }
        }
        return yield* fileSystem.rename(extractionRoot, destinationRoot).pipe(
          Effect.andThen(() => assertExecutableInRoot(destinationRoot, destinationExecutable)),
          Effect.catch((renameError) =>
            findMatchingBinarySlot(paths, target).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(renameError),
                  onSome: (slot) => assertExecutableInRoot(slot.root, slot.executablePath),
                }),
              ),
              Effect.mapError(() => renameError),
            ),
          ),
        );
      }).pipe(Effect.scoped),
    ).pipe(
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not install ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );
  });

  const findAgent = Effect.fn("AcpRegistryCatalog.findAgent")(function* (
    registry: AcpRegistryIndex,
    agentId: string,
  ) {
    const agent = registry.agents.find((candidate) => candidate.id === agentId.trim());
    if (agent === undefined) {
      return yield* new AcpRegistryError({
        reason: "agent_not_found",
        detail: `ACP Registry does not contain agent '${agentId.trim()}'.`,
      });
    }
    return agent;
  });

  const compatibleDistribution = Effect.fn("AcpRegistryCatalog.compatibleDistribution")(function* (
    agent: AcpRegistryAgent,
    preference: AcpRegistryDistributionPreference,
  ) {
    const distribution = resolveAcpRegistryDistribution({
      agent,
      preference,
      platformTarget,
    });
    if (distribution === undefined) {
      return yield* new AcpRegistryError({
        reason: platformTarget === undefined ? "unsupported_platform" : "unsupported_distribution",
        detail: `ACP Registry agent ${agent.id} has no ${preference === "auto" ? "compatible" : preference} distribution for ${platform}-${architecture}.`,
      });
    }
    return distribution;
  });

  const search: AcpRegistryCatalog["Service"]["search"] = Effect.fn("AcpRegistryCatalog.search")(
    function* (input) {
      const { index: registry } = yield* recentRegistry();
      const ranked = [];
      const managerAvailability = new Map<string, boolean>();
      for (const agent of registry.agents) {
        const distribution = resolveAcpRegistryDistribution({
          agent,
          preference: "auto",
          platformTarget,
        });
        const rank = searchRank(agent, input.query);
        if (distribution === undefined || rank === undefined) continue;
        const packageManager = packageManagerFor(distribution.kind);
        if (packageManager !== undefined) {
          let available = managerAvailability.get(packageManager);
          if (available === undefined) {
            available = (yield* resolveExecutable(packageManager, hostEnvironment)) !== undefined;
            managerAvailability.set(packageManager, available);
          }
          if (!available) continue;
        }
        ranked.push({ agent, distribution, rank });
      }
      ranked.sort(
        (left, right) =>
          left.rank - right.rank ||
          compareText(left.agent.name.toLowerCase(), right.agent.name.toLowerCase()) ||
          compareText(left.agent.id, right.agent.id),
      );
      const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
      return {
        agents: ranked.slice(0, limit).map(({ agent, distribution }) => ({
          id: agent.id,
          name: agent.name,
          version: agent.version,
          description: agent.description,
          authors: agent.authors ?? [],
          license: agent.license ?? null,
          website: agent.website ?? null,
          repository: agent.repository ?? null,
          icon: agent.icon ?? null,
          distribution: distribution.kind,
          integrity:
            distribution.kind === "binary" && distribution.binaryTarget?.sha256 !== undefined
              ? "sha256"
              : "registry",
        })),
      } satisfies AcpRegistrySearchResult;
    },
  );

  const prepare: AcpRegistryCatalog["Service"]["prepare"] = Effect.fn("AcpRegistryCatalog.prepare")(
    function* (input) {
      const { index: registry } = yield* refreshRegistry();
      const agent = yield* findAgent(registry, input.agentId);
      const distribution = yield* compatibleDistribution(agent, "auto");
      if (distribution.kind === "binary") {
        // Only explicit command overrides may use PATH copies with different ACP capabilities.
        yield* withInstallPermit(agent.id)(
          installBinary(agent, distribution.binaryTarget!).pipe(
            Effect.tap(() => reservePreparedBinary(agent.id)),
          ),
        );
      } else {
        yield* withInstallPermit(agent.id)(
          ensureGlobalPackage(agent, distribution.kind, distribution.packageName!, hostEnvironment),
        );
      }
      return {
        agentId: agent.id,
        version: agent.version,
        distribution: distribution.kind,
        prepared: true,
      } satisfies AcpRegistryPrepareResult;
    },
  );

  const validateLocalExecutable = (command: string) =>
    platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
      ? Effect.fail(
          new AcpRegistryError({
            reason: "runner_unavailable",
            detail:
              "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
          }),
        )
      : Effect.void;

  const inspect: AcpRegistryCatalog["Service"]["inspect"] = Effect.fn("AcpRegistryCatalog.inspect")(
    function* (settings, environment) {
      if (settings.source === "local") {
        const command = settings.commandPath.trim();
        if (!command) return { status: "unconfigured" } as const;
        const executable = yield* resolveExecutable(command, environment ?? hostEnvironment);
        if (executable !== undefined) yield* validateLocalExecutable(executable);
        return executable === undefined
          ? ({
              status: "missing_runner",
              version: null,
              distribution: "local",
            } as const)
          : ({ status: "ready", agentId: command, version: null, distribution: "local" } as const);
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) return { status: "unconfigured" } as const;
      const { index: registry, indexRevision } = yield* loadRegistrySnapshot();
      const agent = registry.agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return { status: "not_found", agentId, indexRevision } as const;
      const documentationUrl = agent.website ?? agent.repository;
      const icon = agent.icon;
      const distribution = resolveAcpRegistryDistribution({
        agent,
        preference: settings.distribution,
        platformTarget,
      });
      if (distribution === undefined) {
        return { status: "unsupported", agentId, version: agent.version, indexRevision } as const;
      }

      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const available =
          (yield* resolveExecutable(commandOverride, environment ?? hostEnvironment)) !== undefined;
        return available
          ? ({
              status: "ready",
              agentId,
              version: null,
              distribution: distribution.kind,
              launchIdentity: registryLaunchIdentity({
                version: null,
                distribution,
                commandOverride,
              }),
              indexRevision,
              ...(icon ? { icon } : {}),
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const)
          : ({
              status: "missing_runner",
              agentId,
              version: agent.version,
              distribution: distribution.kind,
              runner: commandOverride,
              indexRevision,
            } as const);
      }

      if (distribution.kind === "binary") {
        return yield* withInstallPermit(agent.id)(
          Effect.gen(function* () {
            const paths = binaryPaths(agent, distribution.binaryTarget!);
            if (paths === undefined) {
              return {
                status: "unsupported",
                agentId,
                version: agent.version,
                indexRevision,
              } as const;
            }
            yield* consumePreparedBinaryReservation(agent.id);
            const activeSlot = yield* findMatchingBinarySlot(paths, distribution.binaryTarget!);
            // Any prepared version keeps the agent ready; resolve installs the current one on demand.
            if (Option.isNone(activeSlot) && !(yield* hasInstalledBinaryVersion(agent.id))) {
              return {
                status: "unprepared",
                agentId,
                version: agent.version,
                distribution: "binary",
                indexRevision,
              } as const;
            }
            if (Option.isSome(activeSlot)) {
              yield* assertExecutableInRoot(
                activeSlot.value.root,
                activeSlot.value.executablePath,
              ).pipe(
                Effect.mapError((cause) =>
                  isAcpRegistryError(cause)
                    ? cause
                    : new AcpRegistryError({
                        reason: "install_failed",
                        detail: `Could not validate cached ACP Registry agent ${agent.id}.`,
                        cause,
                      }),
                ),
              );
            }
            return {
              status: "ready",
              agentId,
              version: agent.version,
              distribution: "binary",
              launchIdentity: registryLaunchIdentity({ version: agent.version, distribution }),
              indexRevision,
              ...(icon ? { icon } : {}),
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const;
          }),
        );
      }

      const runner = packageManagerFor(distribution.kind)!;
      const available =
        (yield* resolveExecutable(runner, environment ?? hostEnvironment)) !== undefined;
      return available
        ? ({
            status: "ready",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            launchIdentity: registryLaunchIdentity({ version: agent.version, distribution }),
            indexRevision,
            ...(icon ? { icon } : {}),
            ...(documentationUrl ? { documentationUrl } : {}),
          } as const)
        : ({
            status: "missing_runner",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            runner,
            indexRevision,
          } as const);
    },
  );

  const buildResolvedRegistrySpawn = Effect.fn("AcpRegistryCatalog.buildResolvedRegistrySpawn")(
    function* (input: {
      readonly agent: AcpRegistryAgent;
      readonly distribution: ResolvedAcpRegistryDistribution;
      readonly command: string;
      readonly commandBinDirectory?: string;
      readonly commandOverride?: string;
      readonly cwd: string;
      readonly effectiveEnvironment: NodeJS.ProcessEnv;
      readonly indexRevision?: number;
      readonly fallback?: boolean;
      readonly failedTarget?: AcpRegistryFailedTarget;
    }) {
      const baseSpawnEnvironment = {
        ...input.effectiveEnvironment,
        ...input.distribution.env,
      };
      const pathEnvironment =
        input.commandBinDirectory === undefined
          ? baseSpawnEnvironment
          : withPreferredPath(baseSpawnEnvironment, input.commandBinDirectory, platform);
      const spawnEnvironment =
        runtimeTempDir !== undefined && UNPACKING_AGENT_IDS.has(input.agent.id)
          ? yield* acquireRuntimeTempEnvironment(runtimeTempDir, pathEnvironment)
          : pathEnvironment;
      return {
        agent: input.agent,
        distribution: input.distribution.kind,
        launchIdentity: registryLaunchIdentity({
          version: input.commandOverride ? null : input.agent.version,
          distribution: input.distribution,
          ...(input.commandOverride ? { commandOverride: input.commandOverride } : {}),
        }),
        ...(input.indexRevision === undefined ? {} : { indexRevision: input.indexRevision }),
        ...(input.fallback ? { fallback: true } : {}),
        ...(input.failedTarget === undefined ? {} : { failedTarget: input.failedTarget }),
        spawn: {
          command: input.command,
          args: input.distribution.args,
          cwd: input.cwd,
          env: spawnEnvironment,
        },
      } satisfies ResolvedAcpRegistryAgent;
    },
  );

  const resolveFallbackInstalledBinary = Effect.fn(
    "AcpRegistryCatalog.resolveFallbackInstalledBinary",
  )(function* (
    settings: AcpRegistrySettings,
    cwd: string,
    environment: NodeJS.ProcessEnv | undefined,
    registry: AcpRegistryIndex,
    indexRevision: number,
  ) {
    if (settings.commandPath.trim().length > 0 || platformTarget === undefined) {
      return Option.none<ResolvedAcpRegistryAgent>();
    }
    const agent = registry.agents.find((candidate) => candidate.id === settings.agentId.trim());
    if (agent === undefined) return Option.none<ResolvedAcpRegistryAgent>();
    const distribution = resolveAcpRegistryDistribution({
      agent,
      preference: settings.distribution,
      platformTarget,
    });
    if (distribution === undefined || distribution.kind !== "binary") {
      return Option.none<ResolvedAcpRegistryAgent>();
    }
    const failedTarget: AcpRegistryFailedTarget = {
      version: agent.version,
      launchIdentity: registryLaunchIdentity({ version: agent.version, distribution }),
      indexRevision,
    };
    const effectiveEnvironment = environment ?? hostEnvironment;
    return yield* withInstallPermit(agent.id)(
      Effect.gen(function* () {
        // Fall back only to receipted versions strictly older than the registry's current version
        // so failed upgrades do not strand the agent and upstream rollbacks never run a newer build.
        const agentRoot = path.join(installsDirectory, agent.id);
        const versions = (yield* fileSystem
          .readDirectory(agentRoot)
          .pipe(Effect.orElseSucceed((): Array<string> => [])))
          .filter(
            (entry) => compareRegistryVersions(safeDecodeVersionDir(entry), agent.version) < 0,
          )
          .toSorted((left, right) =>
            compareRegistryVersions(safeDecodeVersionDir(right), safeDecodeVersionDir(left)),
          );
        // Read the launch-options sidecar BEFORE reading slot receipts so a concurrent writer that
        // publishes a newer receipt and then prunes the older sidecar cannot leave fallback seeing
        // both the older receipt and the post-prune empty sidecar.
        const diskOverrideResult = (yield* fileSystem
          .exists(binaryLaunchOptionsPath)
          .pipe(Effect.orElseSucceed(() => false)))
          ? yield* readBinaryLaunchOptionsFile(fileSystem, binaryLaunchOptionsPath)
          : ({ status: "ok", entries: {} } as const);
        for (const versionDir of versions) {
          const versionRoot = path.join(agentRoot, versionDir);
          const entries = yield* fileSystem
            .readDirectory(versionRoot)
            .pipe(Effect.orElseSucceed((): Array<string> => []));
          for (const candidateTarget of resolveAcpRegistryPlatformTargetCandidates(
            platformTarget,
          )) {
            const matchedDirs = entries.filter((entry) =>
              isBinaryPlatformEntry(entry, candidateTarget),
            );
            const candidatesWithMtime = yield* Effect.forEach(matchedDirs, (entry) => {
              const dir = path.join(versionRoot, entry);
              return fileSystem.stat(dir).pipe(
                Effect.map((info) => ({
                  dir,
                  entry,
                  isPrimary: entry === candidateTarget,
                  mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
                })),
                Effect.orElseSucceed(() => ({
                  dir,
                  entry,
                  isPrimary: entry === candidateTarget,
                  mtimeMs: 0,
                })),
              );
            });
            candidatesWithMtime.sort(
              (left, right) =>
                right.mtimeMs - left.mtimeMs ||
                Number(left.isPrimary) - Number(right.isPrimary) ||
                left.entry.localeCompare(right.entry),
            );
            for (const { dir } of candidatesWithMtime) {
              const rawReceipt = yield* fileSystem
                .readFileString(path.join(dir, BINARY_ARTIFACT_RECEIPT_FILENAME))
                .pipe(Effect.option);
              const decoded = Option.flatMap(rawReceipt, decodeBinaryArtifactReceipt);
              if (Option.isNone(decoded)) continue;
              const receipt = decoded.value;
              const commandSegments = normalizeRegistryCommandPath(receipt.cmd);
              if (commandSegments === undefined) continue;
              const executablePath = path.join(dir, ...commandSegments);
              if (
                !(yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false)))
              ) {
                continue;
              }
              const validated = yield* assertExecutableInRoot(dir, executablePath).pipe(
                Effect.option,
              );
              if (Option.isNone(validated)) continue;
              const diskOverride =
                diskOverrideResult.status === "ok" ? diskOverrideResult.entries[dir] : undefined;
              const durableFromSidecar =
                receiptMatchesInstall(diskOverride, receipt) &&
                (diskOverride.launchOptionsRevision ?? 0) > (receipt.launchOptionsRevision ?? 0);
              const durableReceipt = durableFromSidecar ? diskOverride : receipt;
              const pendingOverride = pendingLaunchOptionsBySlotRoot.get(dir);
              const usePendingOverride =
                pendingOverride !== undefined &&
                receiptMatchesInstall(pendingOverride.receipt, receipt) &&
                (receipt.launchOptionsRevision ?? 0) <= pendingOverride.baseReceiptRevision &&
                (durableReceipt.launchOptionsRevision ?? 0) <=
                  pendingOverride.baseDurableRevision &&
                (!durableFromSidecar ||
                  (durableReceipt.launchOptionsRecoveryId ?? null) ===
                    pendingOverride.baseRecoveryId);
              if (pendingOverride !== undefined && !usePendingOverride) {
                pendingLaunchOptionsBySlotRoot.delete(dir);
              }
              const effectiveReceipt = usePendingOverride
                ? pendingOverride.receipt
                : durableReceipt;
              const fallbackVersion = effectiveReceipt.version ?? safeDecodeVersionDir(versionDir);
              const fallbackArgs = effectiveReceipt.args ?? [];
              const fallbackEnv = effectiveReceipt.env ?? {};
              const fallbackTarget: typeof AcpRegistryBinaryTarget.Type = {
                archive: receipt.archive,
                cmd: receipt.cmd,
                ...(receipt.sha256 ? { sha256: receipt.sha256 } : {}),
                ...(fallbackArgs.length > 0 ? { args: fallbackArgs } : {}),
                ...(Object.keys(fallbackEnv).length > 0 ? { env: fallbackEnv } : {}),
              };
              const fallbackDistribution: ResolvedAcpRegistryDistribution = {
                kind: "binary",
                binaryTarget: fallbackTarget,
                args: fallbackArgs,
                env: fallbackEnv,
              };
              const fallbackAgent: AcpRegistryAgent = { ...agent, version: fallbackVersion };
              const resolved = yield* buildResolvedRegistrySpawn({
                agent: fallbackAgent,
                distribution: fallbackDistribution,
                command: validated.value,
                cwd,
                effectiveEnvironment,
                fallback: true,
                failedTarget,
              });
              return Option.some(resolved);
            }
          }
        }
        return Option.none<ResolvedAcpRegistryAgent>();
      }),
    );
  });

  const resolveWithRegistry = Effect.fn("AcpRegistryCatalog.resolveWithRegistry")(function* (
    settings: AcpRegistrySettings,
    cwd: string,
    environment: NodeJS.ProcessEnv | undefined,
    registry: AcpRegistryIndex,
    indexRevision: number,
  ) {
    const agentId = settings.agentId.trim();
    if (agentId.length === 0) {
      return yield* new AcpRegistryError({
        reason: "agent_not_configured",
        detail: "ACP Registry provider requires a registry agent ID.",
      });
    }
    const agent = yield* findAgent(registry, agentId);
    const distribution = yield* compatibleDistribution(agent, settings.distribution);

    let command: string;
    let commandBinDirectory: string | undefined;
    const effectiveEnvironment = environment ?? hostEnvironment;
    const commandOverride = settings.commandPath.trim();
    if (commandOverride.length > 0) {
      const resolvedOverride = yield* resolveExecutable(commandOverride, effectiveEnvironment);
      if (resolvedOverride === undefined) {
        return yield* new AcpRegistryError({
          reason: "runner_unavailable",
          detail: `ACP Registry agent ${agent.id} requires '${commandOverride}', but it is not available on this provider instance's PATH.`,
        });
      }
      command = resolvedOverride;
    } else if (distribution.kind === "npx" || distribution.kind === "uvx") {
      const installed = yield* withInstallPermit(agent.id)(
        ensureGlobalPackage(
          agent,
          distribution.kind,
          distribution.packageName!,
          effectiveEnvironment,
        ),
      );
      command = installed.executablePath;
      commandBinDirectory = installed.binDirectory;
    } else {
      const target = distribution.binaryTarget!;
      command = yield* withInstallPermit(agent.id)(
        installBinary(agent, target).pipe(
          Effect.tap(() => consumePreparedBinaryReservation(agent.id)),
        ),
      );
    }

    return yield* buildResolvedRegistrySpawn({
      agent,
      distribution,
      command,
      ...(commandBinDirectory === undefined ? {} : { commandBinDirectory }),
      ...(commandOverride.length > 0 ? { commandOverride } : {}),
      cwd,
      effectiveEnvironment,
      indexRevision,
    });
  });

  // A cached index can pin a version whose archive was since removed upstream.
  const resolve: AcpRegistryCatalog["Service"]["resolve"] = Effect.fn("AcpRegistryCatalog.resolve")(
    function* (settings, cwd, environment) {
      if (settings.source === "local") {
        const executable = settings.commandPath.trim();
        if (!executable) {
          return yield* new AcpRegistryError({
            reason: "agent_not_configured",
            detail: "Local ACP provider requires an executable.",
          });
        }
        const env = environment ?? hostEnvironment;
        const command = yield* resolveExecutable(executable, env);
        if (command === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: "Local ACP executable is not available on this environment's PATH.",
          });
        }
        yield* validateLocalExecutable(command);
        return {
          distribution: "local",
          spawn: { command, args: settings.commandArgs, cwd, env, shell: false },
        } satisfies ResolvedAcpRegistryAgent;
      }
      const { index: registry, indexRevision } = yield* loadRegistrySnapshot();
      const canFallbackOnError = (reason: AcpRegistryErrorReason) =>
        reason === "download_failed" ||
        reason === "checksum_mismatch" ||
        reason === "archive_invalid";
      return yield* resolveWithRegistry(settings, cwd, environment, registry, indexRevision).pipe(
        Effect.catchIf(
          (error) => canFallbackOnError(error.reason),
          (error) =>
            Effect.gen(function* () {
              const agentId = settings.agentId.trim();
              const artifactSignatureIn = (index: AcpRegistryIndex) => {
                const agent = index.agents.find((candidate) => candidate.id === agentId);
                if (agent === undefined) return undefined;
                const distribution = resolveAcpRegistryDistribution({
                  agent,
                  preference: settings.distribution,
                  platformTarget,
                });
                if (distribution === undefined) return agent.version;
                if (distribution.kind === "binary" && distribution.binaryTarget !== undefined) {
                  return `${agent.version}\0${binaryArtifactIdentityKey(distribution.binaryTarget)}`;
                }
                return registryLaunchIdentity({ version: agent.version, distribution });
              };
              let activeRegistry = registry;
              let activeRevision = indexRevision;
              let activeError = error;
              const retryIfSignatureChanged = Effect.fn(
                "AcpRegistryCatalog.retryResolveOnIndexChange",
              )(function* (candidateRegistry: AcpRegistryIndex, candidateRevision: number) {
                if (
                  artifactSignatureIn(candidateRegistry) === artifactSignatureIn(activeRegistry)
                ) {
                  return Option.none<ResolvedAcpRegistryAgent>();
                }
                const retried = yield* Effect.result(
                  resolveWithRegistry(
                    settings,
                    cwd,
                    environment,
                    candidateRegistry,
                    candidateRevision,
                  ),
                );
                if (Result.isSuccess(retried)) return Option.some(retried.success);
                if (!canFallbackOnError(retried.failure.reason)) {
                  return yield* retried.failure;
                }
                activeRegistry = candidateRegistry;
                activeRevision = candidateRevision;
                activeError = retried.failure;
                return Option.none<ResolvedAcpRegistryAgent>();
              });
              if (error.reason === "download_failed") {
                const refreshed = yield* Effect.result(
                  refreshRegistry({ failureBackoffMs: DOWNLOAD_RETRY_REGISTRY_BACKOFF_MS }),
                );
                if (Result.isSuccess(refreshed)) {
                  const retried = yield* retryIfSignatureChanged(
                    refreshed.success.index,
                    refreshed.success.indexRevision,
                  );
                  if (Option.isSome(retried)) return retried.value;
                }
              }
              // Recheck the latest published index (including after any failed retry) so concurrent
              // removals, incompatibilities, or fixes are honored before falling back.
              for (let attempt = 0; attempt < 3; attempt += 1) {
                const latestState = yield* Ref.get(registryState);
                if (
                  latestState.index === undefined ||
                  latestState.indexRevision <= activeRevision ||
                  artifactSignatureIn(latestState.index) === artifactSignatureIn(activeRegistry)
                ) {
                  break;
                }
                const retried = yield* retryIfSignatureChanged(
                  latestState.index,
                  latestState.indexRevision,
                );
                if (Option.isSome(retried)) return retried.value;
              }
              // Final authoritative check on the latest published index right before falling back.
              const finalState = yield* Ref.get(registryState);
              if (finalState.index !== undefined && finalState.indexRevision > activeRevision) {
                const finalAgent = yield* findAgent(finalState.index, agentId);
                yield* compatibleDistribution(finalAgent, settings.distribution);
                if (artifactSignatureIn(finalState.index) !== artifactSignatureIn(activeRegistry)) {
                  return yield* activeError;
                }
                activeRegistry = finalState.index;
                activeRevision = finalState.indexRevision;
              }
              const fallback = yield* resolveFallbackInstalledBinary(
                settings,
                cwd,
                environment,
                activeRegistry,
                activeRevision,
              );
              if (Option.isSome(fallback)) return fallback.value;
              return yield* activeError;
            }),
        ),
      );
    },
  );

  const uninstallManagedBinary: AcpRegistryCatalog["Service"]["uninstallManagedBinary"] = (input) =>
    hostSettings
      .withSnapshot((settings) =>
        withInstallPermit(input.agentId)(
          Effect.gen(function* () {
            const safeAgentId = yield* decodeBoundedAgentId(input.agentId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: "ACP Registry managed binary uninstall received an invalid agent ID.",
                    cause,
                  }),
              ),
            );
            const isReferenced = Object.values(settings.providerInstances).some((instance) => {
              if (
                instance.driver !== "acpRegistry" ||
                instance.config === null ||
                typeof instance.config !== "object"
              )
                return false;
              const config = instance.config as Record<string, unknown>;
              return (
                config.source !== "local" &&
                typeof config.agentId === "string" &&
                config.agentId.trim() === safeAgentId
              );
            });
            if (isReferenced) {
              yield* consumePreparedBinaryReservation(safeAgentId);
              return { agentId: safeAgentId, removed: false };
            }
            if (yield* hasPreparedBinaryReservation(safeAgentId)) {
              return { agentId: safeAgentId, removed: false };
            }
            const agentRoot = path.join(installsDirectory, safeAgentId);
            const existed = yield* fileSystem.exists(agentRoot).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not inspect the managed binary cache for ACP Registry agent ${safeAgentId}.`,
                    cause,
                  }),
              ),
            );
            if (!existed) return { agentId: safeAgentId, removed: false };

            let removed = false;
            yield* Effect.gen(function* () {
              for (const version of yield* fileSystem.readDirectory(agentRoot)) {
                const versionRoot = path.join(agentRoot, version);
                for (const entry of yield* fileSystem.readDirectory(versionRoot)) {
                  if (
                    !/^(?:darwin|linux|windows)-(?:aarch64|x86_64)(?:-[0-9a-f]{12})?$/u.test(entry)
                  )
                    continue;
                  yield* fileSystem.remove(path.join(versionRoot, entry), {
                    recursive: true,
                    force: true,
                  });
                  removed = true;
                }
                if ((yield* fileSystem.readDirectory(versionRoot)).length === 0)
                  yield* fileSystem.remove(versionRoot, { recursive: true });
              }
              if ((yield* fileSystem.readDirectory(agentRoot)).length === 0)
                yield* fileSystem.remove(agentRoot, { recursive: true });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not remove managed binaries for ACP Registry agent ${safeAgentId}.`,
                    cause,
                  }),
              ),
            );
            if (removed) {
              const prefix = `${safeAgentId}\0`;
              for (const key of legacyBaselineBySlotKey.keys()) {
                if (key.startsWith(prefix)) {
                  legacyBaselineBySlotKey.delete(key);
                }
              }
              const agentRootPrefix = `${agentRoot}${path.sep}`;
              for (const slotRoot of pendingLaunchOptionsBySlotRoot.keys()) {
                if (slotRoot === agentRoot || slotRoot.startsWith(agentRootPrefix)) {
                  pendingLaunchOptionsBySlotRoot.delete(slotRoot);
                }
              }
              // Finish durable metadata cleanup before releasing the agent permit so a concurrent
              // reinstall cannot write new entries and have this uninstall prune them afterwards.
              yield* Effect.all([
                fileSystem.exists(legacyBaselinesPath).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((hasBaselinesFile) =>
                    hasBaselinesFile
                      ? withLegacyBaselinesLock((isLockOwned) =>
                          Effect.gen(function* () {
                            const disk = yield* readLegacyBaselinesFile(
                              fileSystem,
                              legacyBaselinesPath,
                            );
                            if (disk.status !== "ok") return;
                            const remaining = Object.fromEntries(
                              Object.entries(disk.baselines).filter(
                                ([key]) => !key.startsWith(prefix),
                              ),
                            );
                            if (
                              Object.keys(remaining).length !== Object.keys(disk.baselines).length
                            ) {
                              if (!(yield* isLockOwned)) return;
                              yield* writeLegacyBaselinesAtomically(remaining);
                            }
                          }),
                        ).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                ),
                fileSystem.exists(binaryLaunchOptionsPath).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((hasLaunchOptionsFile) =>
                    hasLaunchOptionsFile
                      ? updateBinaryLaunchOptionsStore((entries) => {
                          const remaining = Object.fromEntries(
                            Object.entries(entries).filter(
                              ([slotRoot]) =>
                                slotRoot !== agentRoot && !slotRoot.startsWith(agentRootPrefix),
                            ),
                          );
                          return Object.keys(remaining).length !== Object.keys(entries).length
                            ? remaining
                            : null;
                        }).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ]).pipe(Effect.asVoid);
            }
            return { agentId: safeAgentId, removed };
          }),
        ),
      )
      .pipe(
        Effect.catchTags({
          ServerSettingsError: (cause) =>
            new AcpRegistryError({
              reason: "install_failed",
              detail:
                "Could not read provider settings while checking managed ACP binary references.",
              cause,
            }),
        }),
      );

  const currentIndexRevision = () =>
    Ref.get(registryState).pipe(Effect.map((state) => state.indexRevision));

  return AcpRegistryCatalog.of({
    search,
    prepare,
    refreshIndex,
    currentIndexRevision,
    invalidateIndex,
    inspect,
    resolve,
    uninstallManagedBinary,
  });
});
