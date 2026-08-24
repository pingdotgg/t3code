import {
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
  type AcpRegistryDistributionPreference,
  type AcpRegistrySettings,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import {
  mergePathEntries,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 20;
const REGISTRY_REQUEST_TIMEOUT = "30 seconds";
const ARCHIVE_REQUEST_TIMEOUT = "20 minutes";
const PACKAGE_INSTALL_TIMEOUT = "20 minutes";
const PACKAGE_QUERY_TIMEOUT = "30 seconds";

const BoundedAgentId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
);
const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const BoundedVersion = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
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
  agents: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(512)),
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

export class AcpRegistryError extends Schema.TaggedErrorClass<AcpRegistryError>()(
  "AcpRegistryError",
  {
    reason: AcpRegistryErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
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

function userNpmPrefix(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  path: Path.Path,
): string | undefined {
  const baseDirectory =
    platform === "win32"
      ? (environment.LOCALAPPDATA ?? environment.APPDATA ?? environment.USERPROFILE)?.trim()
      : environment.HOME?.trim();
  if (!baseDirectory || !path.isAbsolute(baseDirectory)) return undefined;
  return platform === "win32"
    ? path.join(baseDirectory, "t3code", "npm-global")
    : path.join(baseDirectory, ".local");
}

/**
 * Directories exposing installed ACP Registry commands. The integrated
 * terminal appends them to PATH so globally installed package commands and
 * managed binary agents are both available by name. Best effort: unreadable
 * directories resolve to no entries.
 */
export const acpRegistryManagedBinaryDirectories = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cacheDir: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
}): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const target = resolveAcpRegistryPlatformTarget(input.platform, input.architecture);
    const registryDirectory = input.path.join(input.cacheDir, "acp-registry");
    const installsDirectory = input.path.join(registryDirectory, "agents");
    const packageReceiptsDirectory = input.path.join(registryDirectory, "package-installs");
    const listDirectories = (directory: string) =>
      input.fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): Array<string> => []));
    const directories: Array<string> = [];

    for (const receiptFile of (yield* listDirectories(packageReceiptsDirectory)).toSorted()) {
      const receipt = yield* input.fileSystem
        .readFileString(input.path.join(packageReceiptsDirectory, receiptFile))
        .pipe(
          Effect.map(decodePackageInstallReceipt),
          Effect.orElseSucceed(() => Option.none()),
        );
      if (
        Option.isSome(receipt) &&
        input.path.isAbsolute(receipt.value.binDirectory) &&
        input.path.dirname(receipt.value.executablePath) === receipt.value.binDirectory &&
        (yield* input.fileSystem
          .exists(receipt.value.executablePath)
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        directories.push(receipt.value.binDirectory);
      }
    }

    if (target === undefined) return Array.from(new Set(directories));
    const cachedAgents = yield* input.fileSystem
      .readFileString(input.path.join(registryDirectory, "registry.json"))
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
      cachedAgents.map((agent) => [`${agent.id}\0${agent.version}`, agent] as const),
    );
    for (const agent of (yield* listDirectories(installsDirectory)).toSorted()) {
      const versions = (yield* listDirectories(input.path.join(installsDirectory, agent))).toSorted(
        (left, right) => right.localeCompare(left, undefined, { numeric: true }),
      );
      for (const version of versions) {
        const installRoot = input.path.join(installsDirectory, agent, version, target);
        if (yield* input.fileSystem.exists(installRoot).pipe(Effect.orElseSucceed(() => false))) {
          const binaryTarget = cachedAgentByInstall.get(`${agent}\0${version}`)?.distribution
            .binary?.[target];
          const commandSegments =
            binaryTarget === undefined ? undefined : normalizeRegistryCommandPath(binaryTarget.cmd);
          const directory =
            commandSegments === undefined
              ? installRoot
              : input.path.join(installRoot, ...commandSegments.slice(0, -1));
          if (yield* input.fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false))) {
            directories.push(directory);
          }
        }
      }
    }
    return Array.from(new Set(directories));
  });

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
  const binary = platformTarget ? agent.distribution.binary?.[platformTarget] : undefined;
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
  readonly agent: AcpRegistryAgent;
  readonly distribution: AcpRegistryDistributionKind;
  readonly spawn: AcpSpawnInput;
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
      readonly status: "unprepared";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: "binary";
    }
  | {
      readonly status: "ready";
      readonly agentId: string;
      readonly version: string;
      readonly distribution: AcpRegistryDistributionKind;
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
      isReferenced?: Effect.Effect<boolean, AcpRegistryError>,
    ) => Effect.Effect<AcpRegistryManagedBinaryUninstallResult, AcpRegistryError>;
  }
>()("t3/provider/acp/AcpRegistrySupport/AcpRegistryCatalog") {
  static layer(options: AcpRegistryCatalogOptions) {
    return Layer.effect(AcpRegistryCatalog, makeAcpRegistryCatalog(options));
  }
}

export interface AcpRegistryCatalogOptions {
  readonly cacheDir: string;
  readonly registryUrl?: string;
}

const INSTALL_LOCK_RETRY_COUNT = 300;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;
const PREPARED_BINARY_RESERVATION_MS = 30 * 1_000;

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
    .every((entry) => normalizeRegistryCommandPath(entry) !== undefined);
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
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostEnvironment = yield* HostProcessEnvironment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const platformTarget = resolveAcpRegistryPlatformTarget(platform, architecture);
  const registryUrl = input.registryUrl ?? ACP_REGISTRY_URL;
  const registryDirectory = path.join(input.cacheDir, "acp-registry");
  const registryCachePath = path.join(registryDirectory, "registry.json");
  const installsDirectory = path.join(registryDirectory, "agents");
  const packageReceiptsDirectory = path.join(registryDirectory, "package-installs");
  const registryRef = yield* Ref.make<AcpRegistryIndex | undefined>(undefined);
  const registryRevision = yield* Ref.make(0);
  const registrySemaphore = yield* Semaphore.make(1);
  const installSemaphore = yield* Semaphore.make(1);
  const preparedBinaryReservations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const managerBinDirectory = Effect.fn("AcpRegistryCatalog.managerBinDirectory")(function* (
    runner: string,
  ) {
    const linkedTarget = yield* fileSystem.readLink(runner).pipe(Effect.option);
    if (Option.isNone(linkedTarget)) return path.dirname(runner);
    const target = path.isAbsolute(linkedTarget.value)
      ? linkedTarget.value
      : path.resolve(path.dirname(runner), linkedTarget.value);
    // Some service installs expose npm/uv through a wrapper symlink into the
    // actual toolchain bin directory. Do not mistake npm's internal
    // `npm-cli.js` directory for the global command directory.
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
  ) {
    const valid = yield* decodeHttpsUrl(value).pipe(Effect.option);
    if (Option.isNone(valid)) {
      return yield* new AcpRegistryError({ reason: "registry_unavailable", detail });
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

  const writeRegistryCache = (text: string) => {
    const temporaryPath = `${registryCachePath}.${process.pid}-${NodeCrypto.randomUUID()}.tmp`;
    return fileSystem
      .makeDirectory(registryDirectory, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(temporaryPath, text)),
        Effect.andThen(fileSystem.rename(temporaryPath, registryCachePath)),
        Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
        Effect.ignore,
      );
  };

  const fetchRegistry = Effect.fn("AcpRegistryCatalog.fetchRegistry")(function* () {
    yield* assertHttpsUrl(registryUrl, "ACP Registry index URL must use HTTPS.");
    const response = yield* httpClient.execute(HttpClientRequest.get(registryUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: `Could not fetch ACP Registry index from ${registryUrl}.`,
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
            }),
          ),
      }),
    );
    if (collected.truncated || collected.bytes > MAX_REGISTRY_BYTES) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: `ACP Registry index exceeds ${MAX_REGISTRY_BYTES} bytes.`,
      });
    }
    if (collected.invalidUtf8) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "ACP Registry index is not valid UTF-8.",
      });
    }
    const registry = yield* decodeRegistryText(collected.text);
    yield* writeRegistryCache(collected.text);
    return registry;
  });

  const refreshRegistry = Effect.fn("AcpRegistryCatalog.refreshRegistry")(function* () {
    const observedRevision = yield* Ref.get(registryRevision);
    return yield* registrySemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentRevision = yield* Ref.get(registryRevision);
        const current = yield* Ref.get(registryRef);
        if (current !== undefined && currentRevision !== observedRevision) return current;

        const registry = yield* fetchRegistry().pipe(
          Effect.catch((networkError) =>
            readCachedRegistry.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(networkError),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
        );
        yield* Ref.set(registryRef, registry);
        yield* Ref.update(registryRevision, (revision) => revision + 1);
        return registry;
      }),
    );
  });

  const loadCachedRegistry = Effect.fn("AcpRegistryCatalog.loadCachedRegistry")(function* () {
    const current = yield* Ref.get(registryRef);
    if (current !== undefined) return current;

    const cached = yield* readCachedRegistry;
    if (Option.isNone(cached)) {
      return yield* new AcpRegistryError({
        reason: "registry_unavailable",
        detail: "No valid cached ACP Registry index is available.",
      });
    }
    yield* Ref.set(registryRef, cached.value);
    return cached.value;
  });

  const loadRegistry = Effect.fn("AcpRegistryCatalog.loadRegistry")(function* () {
    return yield* loadCachedRegistry().pipe(Effect.catch(() => refreshRegistry()));
  });

  const runCommand = Effect.fn("AcpRegistryCatalog.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeout?: Duration.Input;
      readonly truncatedOutputReason?: AcpRegistryErrorReason;
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
          collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 1024 * 1024 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry install command '${command}' exited with code ${Number(exitCode)}: ${stderr.text.trim()}`,
        });
      }
      // Archive listings feed validateArchiveEntries; a truncated listing would let
      // unvalidated entries past the traversal check, so oversized output is fatal.
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
                  reason: "install_failed",
                  detail: `Timed out running ACP Registry install command '${command}'.`,
                }),
              ),
          }),
        );
  });

  const packageReceiptPath = (
    agentId: string,
    distribution: "npx" | "uvx",
    managerPath: string,
  ) => {
    const managerId = NodeCrypto.createHash("sha256")
      .update(`${distribution}\0${managerPath}`)
      .digest("hex")
      .slice(0, 16);
    return path.join(packageReceiptsDirectory, `${agentId}-${managerId}.json`);
  };

  const readPackageReceipt = Effect.fn("AcpRegistryCatalog.readPackageReceipt")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    managerPath: string,
  ) {
    const receipt = yield* fileSystem
      .readFileString(packageReceiptPath(agent.id, distribution, managerPath))
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
      !path.isAbsolute(receipt.value.binDirectory) ||
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
      const receiptPath = packageReceiptPath(
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

  const npmGlobalEnvironment = Effect.fn("AcpRegistryCatalog.npmGlobalEnvironment")(function* (
    managerPath: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const managerDirectory = yield* managerBinDirectory(managerPath);
    const managerEnvironment = withPreferredPath(environment, managerDirectory, platform);
    const configuredPrefix = yield* runCommand(managerPath, ["prefix", "--global"], {
      env: managerEnvironment,
      timeout: PACKAGE_QUERY_TIMEOUT,
      truncatedOutputReason: "install_failed",
    }).pipe(Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)));
    const ensureWritable = (directory: string) =>
      fileSystem.makeDirectory(directory, { recursive: true }).pipe(
        Effect.flatMap(() => fileSystem.access(directory, { writable: true })),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (yield* ensureWritable(configuredPrefix)) return managerEnvironment;

    const fallbackPrefix = userNpmPrefix(environment, platform, path);
    if (fallbackPrefix === undefined || !(yield* ensureWritable(fallbackPrefix))) {
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: `ACP Registry cannot write to npm's global prefix '${configuredPrefix}' and could not create a writable user prefix.`,
      });
    }
    return { ...managerEnvironment, npm_config_prefix: fallbackPrefix };
  });

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
      const executablePath = resolveExecutable(
        commandName,
        platform,
        withPreferredPath(environment, binDirectory, platform),
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
      const commandEnvironment = withPreferredPath(environment, binDirectory, platform);
      const executablePath = packageCommandCandidates(agent, packageIdentity.name)
        .map((candidate) => resolveExecutable(candidate, platform, commandEnvironment))
        .find((candidate): candidate is string => candidate !== undefined);
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
    const managerPath = resolveExecutable(managerName, platform, environment);
    if (managerPath === undefined) {
      return yield* new AcpRegistryError({
        reason: "runner_unavailable",
        detail: `ACP Registry agent ${agent.id} requires '${managerName}', but it is not available on this environment's PATH.`,
      });
    }
    const receipt = yield* readPackageReceipt(agent, distribution, packageSpec, managerPath);
    if (Option.isSome(receipt) && distribution === "npx") return receipt.value;

    const packageEnvironment =
      distribution === "npx" ? yield* npmGlobalEnvironment(managerPath, environment) : environment;
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

  const acquireInstallLock = Effect.fn("AcpRegistryCatalog.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (acquired) return;
      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_STALE_MS) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      yield* Effect.sleep(INSTALL_LOCK_RETRY_DELAY);
    }
    return yield* new AcpRegistryError({
      reason: "install_failed",
      detail: `Timed out waiting for ACP Registry install lock ${lockPath}.`,
    });
  });

  const assertExecutableInRoot = Effect.fn("AcpRegistryCatalog.assertExecutableInRoot")(function* (
    root: string,
    executablePath: string,
  ) {
    const rootRealPath = yield* fileSystem.realPath(root);
    const executableRealPath = yield* fileSystem.realPath(executablePath);
    const relative = path.relative(rootRealPath, executableRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command resolves outside its installation directory.",
      });
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
    if (platformTarget === undefined || commandSegments === undefined) return undefined;
    const installRoot = path.join(installsDirectory, agent.id, agent.version, platformTarget);
    return {
      commandSegments,
      installRoot,
      executablePath: path.join(installRoot, ...commandSegments),
    };
  };

  /**
   * An already-installed copy of a registry agent's binary on the instance
   * PATH (for example a package-manager installed `kimi`). Checked before
   * downloading the managed copy so existing installs are detected for every
   * binary-distribution agent. A present managed install still wins so
   * prepared agents stay on their pinned, checksum-verified version.
   */
  const resolveSystemAgentBinary = (
    target: typeof AcpRegistryBinaryTarget.Type,
    environment: NodeJS.ProcessEnv,
  ): string | undefined => {
    const name = target.cmd.trim().split(/[\\/]/u).pop() ?? "";
    if (name.length === 0 || name === "." || name === "..") return undefined;
    return resolveExecutable(name, platform, environment);
  };

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
    const { commandSegments, installRoot, executablePath } = paths;
    if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
      return yield* assertExecutableInRoot(installRoot, executablePath).pipe(
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
    yield* acquireInstallLock(lockPath).pipe(
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not acquire install lock for ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );

    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
        return yield* assertExecutableInRoot(installRoot, executablePath);
      }
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(installRoot),
        prefix: `.${agent.id}-install-`,
      });
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
      const hash = NodeCrypto.createHash("sha256");
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
        const actual = hash.digest("hex");
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
        const listArgs =
          kind === "tar_gz"
            ? ["-tzf", archivePath]
            : kind === "tar_bz2"
              ? ["-tjf", archivePath]
              : platform === "win32"
                ? ["-tf", archivePath]
                : undefined;
        const entries =
          listArgs === undefined
            ? yield* runCommand("unzip", ["-Z1", archivePath])
            : yield* runCommand("tar", listArgs);
        if (!validateArchiveEntries(entries)) {
          return yield* new AcpRegistryError({
            reason: "archive_invalid",
            detail: `ACP Registry agent ${agent.id} archive contains an unsafe path.`,
          });
        }
        if (kind === "zip" && platform !== "win32") {
          yield* runCommand("unzip", ["-q", archivePath, "-d", extractionRoot]);
        } else {
          const extractFlag = kind === "tar_gz" ? "-xzf" : kind === "tar_bz2" ? "-xjf" : "-xf";
          yield* runCommand("tar", [extractFlag, archivePath, "-C", extractionRoot]);
        }
      }

      const stagedExecutable = path.join(extractionRoot, ...commandSegments);
      if (!(yield* fileSystem.exists(stagedExecutable).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new AcpRegistryError({
          reason: "archive_invalid",
          detail: `ACP Registry archive for ${agent.id} did not contain '${target.cmd}'.`,
        });
      }
      if (platform !== "win32") yield* fileSystem.chmod(stagedExecutable, 0o755);
      yield* assertExecutableInRoot(extractionRoot, stagedExecutable);
      yield* fileSystem.remove(installRoot, { recursive: true, force: true });
      yield* fileSystem.rename(extractionRoot, installRoot);
      return yield* assertExecutableInRoot(installRoot, executablePath);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
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

  const search: AcpRegistryCatalog["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const registry = yield* refreshRegistry();
      const ranked = registry.agents.flatMap((agent) => {
        const distribution = resolveAcpRegistryDistribution({
          agent,
          preference: "auto",
          platformTarget,
        });
        const rank = searchRank(agent, input.query);
        const packageManager =
          distribution === undefined ? undefined : packageManagerFor(distribution.kind);
        const packageManagerAvailable =
          packageManager === undefined ||
          resolveExecutable(packageManager, platform, hostEnvironment) !== undefined;
        return distribution === undefined || rank === undefined || !packageManagerAvailable
          ? []
          : [{ agent, distribution, rank }];
      });
      ranked.sort(
        (left, right) =>
          left.rank - right.rank ||
          compareText(left.agent.name.toLowerCase(), right.agent.name.toLowerCase()) ||
          compareText(left.agent.id, right.agent.id),
      );
      return {
        agents: ranked.slice(0, MAX_SEARCH_RESULTS).map(({ agent, distribution }) => ({
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
    });

  const prepare: AcpRegistryCatalog["Service"]["prepare"] = (input) =>
    Effect.gen(function* () {
      const registry = yield* refreshRegistry();
      const agent = yield* findAgent(registry, input.agentId);
      const distribution = yield* compatibleDistribution(agent, "auto");
      if (distribution.kind === "binary") {
        // An existing system install satisfies prepare without downloading a
        // duplicate managed copy.
        if (resolveSystemAgentBinary(distribution.binaryTarget!, hostEnvironment) === undefined) {
          yield* installSemaphore.withPermits(1)(
            installBinary(agent, distribution.binaryTarget!).pipe(
              Effect.tap(() => reservePreparedBinary(agent.id)),
            ),
          );
        }
      } else {
        yield* installSemaphore.withPermits(1)(
          ensureGlobalPackage(agent, distribution.kind, distribution.packageName!, hostEnvironment),
        );
      }
      return {
        agentId: agent.id,
        version: agent.version,
        distribution: distribution.kind,
        prepared: true,
      } satisfies AcpRegistryPrepareResult;
    });

  const inspect: AcpRegistryCatalog["Service"]["inspect"] = (settings, environment) =>
    Effect.gen(function* () {
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) return { status: "unconfigured" } as const;
      const registry = yield* loadCachedRegistry();
      const agent = registry.agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return { status: "not_found", agentId } as const;
      const distribution = resolveAcpRegistryDistribution({
        agent,
        preference: settings.distribution,
        platformTarget,
      });
      if (distribution === undefined) {
        return { status: "unsupported", agentId, version: agent.version } as const;
      }

      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const available =
          resolveExecutable(commandOverride, platform, environment ?? hostEnvironment) !==
          undefined;
        return available
          ? ({
              status: "ready",
              agentId,
              version: agent.version,
              distribution: distribution.kind,
            } as const)
          : ({
              status: "missing_runner",
              agentId,
              version: agent.version,
              distribution: distribution.kind,
              runner: commandOverride,
            } as const);
      }

      if (distribution.kind === "binary") {
        return yield* installSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const paths = binaryPaths(agent, distribution.binaryTarget!);
            if (paths === undefined) {
              return { status: "unsupported", agentId, version: agent.version } as const;
            }
            yield* consumePreparedBinaryReservation(agent.id);
            const exists = yield* fileSystem
              .exists(paths.executablePath)
              .pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              if (
                resolveSystemAgentBinary(
                  distribution.binaryTarget!,
                  environment ?? hostEnvironment,
                ) !== undefined
              ) {
                return {
                  status: "ready",
                  agentId,
                  version: agent.version,
                  distribution: "binary",
                } as const;
              }
              return {
                status: "unprepared",
                agentId,
                version: agent.version,
                distribution: "binary",
              } as const;
            }
            yield* assertExecutableInRoot(paths.installRoot, paths.executablePath).pipe(
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
            return {
              status: "ready",
              agentId,
              version: agent.version,
              distribution: "binary",
            } as const;
          }),
        );
      }

      const runner = packageManagerFor(distribution.kind)!;
      const available =
        resolveExecutable(runner, platform, environment ?? hostEnvironment) !== undefined;
      return available
        ? ({
            status: "ready",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
          } as const)
        : ({
            status: "missing_runner",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            runner,
          } as const);
    });

  const resolve: AcpRegistryCatalog["Service"]["resolve"] = (settings, cwd, environment) =>
    Effect.gen(function* () {
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) {
        return yield* new AcpRegistryError({
          reason: "agent_not_configured",
          detail: "ACP Registry provider requires a registry agent ID.",
        });
      }
      const registry = yield* loadRegistry();
      const agent = yield* findAgent(registry, agentId);
      const distribution = yield* compatibleDistribution(agent, settings.distribution);

      let command: string;
      let args: ReadonlyArray<string>;
      let commandBinDirectory: string | undefined;
      const effectiveEnvironment = environment ?? hostEnvironment;
      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const resolvedOverride = resolveExecutable(commandOverride, platform, effectiveEnvironment);
        if (resolvedOverride === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: `ACP Registry agent ${agent.id} requires '${commandOverride}', but it is not available on this provider instance's PATH.`,
          });
        }
        command = resolvedOverride;
        args = distribution.args;
      } else if (distribution.kind === "npx" || distribution.kind === "uvx") {
        const installed = yield* installSemaphore.withPermits(1)(
          ensureGlobalPackage(
            agent,
            distribution.kind,
            distribution.packageName!,
            effectiveEnvironment,
          ),
        );
        command = installed.executablePath;
        args = distribution.args;
        commandBinDirectory = installed.binDirectory;
      } else {
        const target = distribution.binaryTarget!;
        const paths = binaryPaths(agent, target);
        const managedInstalled =
          paths !== undefined &&
          (yield* fileSystem.exists(paths.executablePath).pipe(Effect.orElseSucceed(() => false)));
        const systemExecutable = managedInstalled
          ? undefined
          : resolveSystemAgentBinary(target, effectiveEnvironment);
        if (systemExecutable !== undefined) {
          command = systemExecutable;
        } else {
          command = yield* installSemaphore.withPermits(1)(
            installBinary(agent, target).pipe(
              Effect.tap(() => consumePreparedBinaryReservation(agent.id)),
            ),
          );
        }
        args = distribution.args;
      }

      const baseSpawnEnvironment = {
        ...effectiveEnvironment,
        ...distribution.env,
      };
      const spawnEnvironment =
        commandBinDirectory === undefined
          ? baseSpawnEnvironment
          : withPreferredPath(baseSpawnEnvironment, commandBinDirectory, platform);

      return {
        agent,
        distribution: distribution.kind,
        spawn: {
          command,
          args,
          cwd,
          env: spawnEnvironment,
        },
      } satisfies ResolvedAcpRegistryAgent;
    });

  const uninstallManagedBinary: AcpRegistryCatalog["Service"]["uninstallManagedBinary"] = (
    input,
    isReferenced = Effect.succeed(false),
  ) =>
    installSemaphore.withPermits(1)(
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
        if (yield* isReferenced) {
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

        yield* fileSystem.remove(agentRoot, { recursive: true, force: true }).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryError({
                reason: "install_failed",
                detail: `Could not remove managed binaries for ACP Registry agent ${safeAgentId}.`,
                cause,
              }),
          ),
        );
        return { agentId: safeAgentId, removed: true };
      }),
    );

  return AcpRegistryCatalog.of({
    search,
    prepare,
    inspect,
    resolve,
    uninstallManagedBinary,
  });
});
