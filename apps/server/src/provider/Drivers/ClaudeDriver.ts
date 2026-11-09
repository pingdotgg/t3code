import {
  UsagePolling,
  UsageAfterReset,
  UsageAccountIdentity,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
  type ClaudeCapabilitiesProbe,
} from "../ClaudeProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  makeClaudeContinuationGroupKey,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeClaudeMaintenanceResolution } from "./ClaudeMaintenance.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);
const ProbeCacheKey = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Boolean]));
const encodeProbeKey = Schema.encodeSync(ProbeCacheKey);
const decodeProbeKey = Schema.decodeSync(ProbeCacheKey);

const withoutUsage = (capabilities: ClaudeCapabilitiesProbe): ClaudeCapabilitiesProbe => {
  const result = { ...capabilities };
  delete result.usage;
  return result;
};

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | SecureRandom.SecureRandom
  | Digest.Digest
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: Effect.fn("ClaudeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const digest = yield* Digest.Digest;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The server cwd is $HOME in packaged desktop builds, and `claude`
    // wrappers that scope themselves to their cwd refuse to run there.
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const usageHttpClient = (yield* ProviderHost.ProviderHost).usageHttpClient;
    const httpClient = usageHttpClient ?? (yield* HttpClient.HttpClient);
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const modelCatalog = catalogService
      .current(DRIVER_KIND)
      .pipe(Effect.map(resolveClaudeModelCatalog));
    const processEnv = yield* mergeClaudeProcessEnvironment(config, environment, process.env);
    const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies ClaudeSettings;
    const resolveMaintenance = yield* makeClaudeMaintenanceResolution({
      binaryPath: effectiveConfig.binaryPath,
      env: processEnv,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig, processEnv);
    const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
    const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
      effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
        ? configDir
        : undefined,
    );
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey,
    });

    const scopedLimitNames = yield* makeClaudeScopedLimitNames;
    const orchestrationAdapter = yield* createClaudeAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      },
      {
        scopedLimitNames,
        onUsageLimits: (update) => snapshot.applyUsageLimits(update),
        modelCatalog,
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Claude orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeClaudeTextGeneration(
      effectiveConfig,
      processEnv,
      modelCatalog,
    );

    // Each instance owns its account; health reads must not populate the usage cache.
    // A transient miss may reuse the last account once, but its usage windows keep their age.
    const lastGoodCapabilities = yield* Ref.make<ClaudeCapabilitiesProbe | undefined>(undefined);
    const capabilitiesProbeCache = yield* Cache.makeWith(
      (key: string) => {
        const [, includeUsage] = decodeProbeKey(key);
        return probeClaudeCapabilities(effectiveConfig, processEnv, stateDir, includeUsage).pipe(
          Effect.flatMap((capabilities) =>
            ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath).pipe(
              Effect.map((workspaceId) => ({
                _tag: "fresh" as const,
                capabilities:
                  workspaceId === undefined ? capabilities : { ...capabilities, workspaceId },
              })),
            ),
          ),
          Effect.tap(({ capabilities }) => Ref.set(lastGoodCapabilities, capabilities)),
          Effect.catch((error) =>
            Ref.getAndSet(lastGoodCapabilities, undefined).pipe(
              Effect.flatMap((capabilities) =>
                capabilities === undefined
                  ? Effect.fail(error)
                  : ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath).pipe(
                      Effect.flatMap((workspaceId) =>
                        workspaceId === capabilities.workspaceId
                          ? Effect.succeed({
                              _tag: "fallback" as const,
                              capabilities: withoutUsage(capabilities),
                            })
                          : Effect.fail(error),
                      ),
                    ),
              ),
            ),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      },
      {
        capacity: 2,
        timeToLive: () => CAPABILITIES_PROBE_TTL,
      },
    );
    let lastAccount: ClaudeCapabilitiesProbe | undefined;
    let lastIdentity: string | undefined;
    const resolveCapabilities = Effect.gen(function* () {
      const identity = yield* ClaudeResetCredits.readClaudeAccountCacheKey(accountConfigPath);
      if (lastIdentity !== identity) {
        yield* Cache.invalidateAll(capabilitiesProbeCache);
        yield* Ref.set(lastGoodCapabilities, undefined);
        lastAccount = undefined;
        lastIdentity = identity;
      }
      let includeUsage = yield* UsagePolling;
      let usageRefreshAfter: number | undefined;
      if (includeUsage && usageHttpClient) {
        const token = yield* ClaudeResetCredits.readAccessToken(configDir).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (token) {
          usageRefreshAfter = yield* usageHttpClient
            .getCooldownDeadline("https://api.anthropic.com", `Bearer ${token}`)
            .pipe(
              Effect.provideService(
                UsageAccountIdentity,
                yield* ClaudeResetCredits.readClaudeUsageAccountIdentity(accountConfigPath),
              ),
            );
          if (usageRefreshAfter !== undefined) includeUsage = false;
        }
      }
      const capabilities: ClaudeCapabilitiesProbe = (yield* Cache.get(
        capabilitiesProbeCache,
        encodeProbeKey([identity, includeUsage]),
      )).capabilities;
      if (
        lastAccount !== undefined &&
        (lastAccount.email?.toLowerCase() !== capabilities.email?.toLowerCase() ||
          lastAccount.workspaceId !== capabilities.workspaceId)
      )
        yield* Cache.invalidate(capabilitiesProbeCache, encodeProbeKey([identity, !includeUsage]));
      lastAccount = capabilities;
      return usageRefreshAfter === undefined
        ? capabilities
        : { ...capabilities, usageRefreshAfter };
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const getUsageRefreshKey = ClaudeResetCredits.readClaudeAccountCacheKey(accountConfigPath).pipe(
      Effect.flatMap((identity) =>
        digest.digest(Digest.sha256, new TextEncoder().encode(identity)),
      ),
      Effect.map(Hex.encode),
      Effect.orDie,
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    const probeProvider = catalogService.refreshInBackground.pipe(
      Effect.andThen(
        modelCatalog.pipe(
          Effect.flatMap((catalog) =>
            checkClaudeProviderStatus(
              effectiveConfig,
              () => resolveCapabilities,
              processEnv,
              stateDir,
              catalog,
              scopedLimitNames,
              (version) =>
                ClaudeResetCredits.readClaudeResetCredits(
                  configDir,
                  version,
                  accountConfigPath,
                ).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                ),
            ),
          ),
          Effect.tap((provider) =>
            provider.auth.status === "unauthenticated"
              ? Cache.invalidateAll(capabilitiesProbeCache)
              : Effect.void,
          ),
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const checkProvider = Effect.gen(function* () {
      const before = yield* getUsageRefreshKey;
      const provider = yield* probeProvider;
      const after = yield* getUsageRefreshKey;
      return stampIdentity(
        before === after
          ? { ...provider, auth: { ...provider.auth, usageRefreshKey: before } }
          : {
              ...provider,
              auth: { status: "unknown", usageRefreshKey: after },
              usageLimits: {
                ...makeUnavailableUsageLimits({
                  checkedAt: provider.checkedAt,
                  reason: "probeFailed",
                }),
                refreshAfter: 0,
              },
            },
      );
    });

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
          Effect.map(stampIdentity),
        ),
      checkProvider,
      getUsageRefreshKey,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    // Same rules as Codex: serialised on the config directory that holds the
    // login, one request id kept until Claude answers (a cooldown or rate
    // limit is an answer), then a re-probe.
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = Effect.fn(
      "ClaudeDriver.consumeResetCredit",
    )(
      function* () {
        const current = yield* snapshot.getSnapshot;
        const grantId = current.usageLimits?.resetCredits?.nextCreditId;
        if (!grantId || !current.version) return "noCredit" as const;
        const version = current.version;
        return yield* resetCreditCoordinator.redeem(
          configDir,
          (requestId) =>
            ClaudeResetCredits.consumeClaudeResetCredit({
              configDir,
              accountConfigPath,
              version,
              grantId,
              requestId,
              ...(usageHttpClient ? { usageHttpClient } : {}),
            }),
          ClaudeResetCredits.isSettledClaudeResetCreditFailure,
        );
      },
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail:
              cause._tag === "ClaudeResetCreditError"
                ? cause.message
                : "Claude could not redeem the reset.",
            cause,
          }),
      ),
      Effect.tap((outcome) =>
        Effect.gen(function* () {
          const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
          yield* Cache.invalidateAll(capabilitiesProbeCache);
          if (usageHttpClient) {
            const token = yield* ClaudeResetCredits.readAccessToken(configDir).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.orElseSucceed(() => undefined),
            );
            if (token)
              yield* usageHttpClient
                .invalidateSuccessfulReads("https://api.anthropic.com", `Bearer ${token}`)
                .pipe(
                  Effect.provideService(
                    UsageAccountIdentity,
                    yield* ClaudeResetCredits.readClaudeUsageAccountIdentity(
                      accountConfigPath,
                    ).pipe(
                      Effect.provideService(FileSystem.FileSystem, fileSystem),
                      Effect.provideService(Path.Path, path),
                    ),
                  ),
                );
          }
          const refreshed = yield* snapshot.refresh.pipe(
            Effect.provideService(UsagePolling, true),
            Effect.provideService(UsageAfterReset, true),
          );
          const after = refreshed.usageLimits?.checkedAt;
          if (
            outcome === "reset" &&
            (after === undefined ||
              after === before ||
              refreshed.usageLimits?.unavailable?.reason === "probeFailed")
          ) {
            return yield* new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail:
                "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
            });
          }
        }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity: {
        ...fallbackContinuationIdentity,
        continuationKey: continuationGroupKey,
      },
      displayName,
      accentColor,
      enabled,
      snapshot,
      invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
      snapshotForCwd: (cwd: string) =>
        snapshot.getSnapshot.pipe(
          Effect.flatMap((machineSnapshot) =>
            probeClaudeWorkspaceSnapshot(effectiveConfig, machineSnapshot, cwd, processEnv),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      orchestrationAdapter,
      textGeneration,
      consumeResetCredit,
    } satisfies ProviderInstance;
  }),
};
