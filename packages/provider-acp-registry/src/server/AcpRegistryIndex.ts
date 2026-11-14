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


import {
  ACP_REGISTRY_URL,
  MAX_REGISTRY_BYTES,
  REGISTRY_REQUEST_TIMEOUT,
  REGISTRY_SEARCH_MAX_AGE_MS,
  type AcpRegistryAgent,
  type AcpRegistryIndex,
  decodeRegistryIndexEnvelope,
  decodeRegistryAgent,
  decodeJson,
  decodeHttpsUrl,
  AcpRegistryError,
  resolveAcpRegistryPlatformTarget,
  AcpRegistryCatalog,
  PREPARED_BINARY_RESERVATION_MS,
} from "./AcpRegistryModel.ts";
import type { AcpRegistryCatalogOptions } from "./AcpRegistryModel.ts";

/** Registry index fetch and cache for the ACP catalog. */
export const makeAcpRegistryIndex = Effect.fn("AcpRegistryIndex.make")(function* (
  input: AcpRegistryCatalogOptions,
) {
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
  const resolveExecutable = yield* SpawnExecutableResolution;
  const platformTarget = resolveAcpRegistryPlatformTarget(platform, architecture);
  const registryUrl = input.registryUrl ?? ACP_REGISTRY_URL;
  const registryDirectory = path.join(input.cacheDir, "acp-registry");
  const registryCachePath = path.join(registryDirectory, "registry.json");
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
  const registryRef = yield* Ref.make<AcpRegistryIndex | undefined>(undefined);
  // When the network last served registryRef; unset while it holds the disk cache.
  const registryFetchedAtMs = yield* Ref.make<number | undefined>(undefined);
  const registryRevision = yield* Ref.make(0);
  const registrySemaphore = yield* Semaphore.make(1);
  // Long installs must only block operations on the same agent.
  const installPermits = new Map<string, Semaphore.Semaphore>();
  const withInstallPermit = (agentId: string) => {
    const permit = installPermits.get(agentId) ?? Semaphore.makeUnsafe(1);
    installPermits.set(agentId, permit);
    return permit.withPermits(1);
  };
  const preparedBinaryReservations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

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

        const { registry, fetched } = yield* fetchRegistry().pipe(
          Effect.map((registry) => ({ registry, fetched: true })),
          Effect.catch((networkError) =>
            readCachedRegistry.pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(networkError),
                  onSome: (registry) => Effect.succeed({ registry, fetched: false }),
                }),
              ),
            ),
          ),
        );
        yield* Ref.set(registryRef, registry);
        yield* Ref.set(registryFetchedAtMs, fetched ? yield* Clock.currentTimeMillis : undefined);
        yield* Ref.update(registryRevision, (revision) => revision + 1);
        return registry;
      }),
    );
  });

  const recentRegistry = Effect.fn("AcpRegistryCatalog.recentRegistry")(function* () {
    const current = yield* Ref.get(registryRef);
    const fetchedAtMs = yield* Ref.get(registryFetchedAtMs);
    const now = yield* Clock.currentTimeMillis;
    // A clock moved back makes the stamp untrustworthy, so it counts as stale.
    if (
      current !== undefined &&
      fetchedAtMs !== undefined &&
      now >= fetchedAtMs &&
      now - fetchedAtMs < REGISTRY_SEARCH_MAX_AGE_MS
    ) {
      return current;
    }
    return yield* refreshRegistry();
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

  return {
    hostSettings,
    random,
    digester,
    sha256Hex,
    fileSystem,
    path,
    httpClient,
    spawner,
    platform,
    architecture,
    hostEnvironment,
    resolveExecutable,
    platformTarget,
    registryUrl,
    registryDirectory,
    registryCachePath,
    installsDirectory,
    agentInstallRoot,
    packageInstallRoot,
    packageBinDirectory,
    packageReceiptsDirectory,
    registryRef,
    registryFetchedAtMs,
    registryRevision,
    registrySemaphore,
    installPermits,
    withInstallPermit,
    preparedBinaryReservations,
    managerBinDirectory,
    reservePreparedBinary,
    consumePreparedBinaryReservation,
    hasPreparedBinaryReservation,
    assertHttpsUrl,
    decodeRegistryText,
    readCachedRegistry,
    writeRegistryCache,
    fetchRegistry,
    refreshRegistry,
    recentRegistry,
    loadCachedRegistry,
    loadRegistry,
  };
});

export type AcpRegistryIndexState = Effect.Success<ReturnType<typeof makeAcpRegistryIndex>>;
