import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createClaudeAdapterV2,
  resolveClaudeModeAvailability,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames, recordClaudeUsageResponse } from "../claudeUsageLimits.ts";
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
import {
  resolveClaudeModelCatalog,
  scopeClaudeUpgradeMessageToChannel,
} from "../ClaudeModelCatalog.ts";
import {
  makeClaudeCodeModelRoutes,
  resolveClaudeModelSettingsKey,
} from "../ClaudeCodeModelRoutes.ts";
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
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hasClaudeAuthenticationOverride } from "./ClaudeSkills.ts";
import { makeClaudeMaintenanceResolution } from "./ClaudeMaintenance.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

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
    usageAccess = Effect.succeed(false),
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    // The server cwd is $HOME in packaged desktop builds, and `claude`
    // wrappers that scope themselves to their cwd refuse to run there.
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const modelCatalog = catalogService
      .current(DRIVER_KIND)
      .pipe(Effect.map(resolveClaudeModelCatalog));
    const processEnv = yield* mergeClaudeProcessEnvironment(
      { ...config, enabled },
      environment,
      process.env,
    );
    const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, homeDirectory),
    } satisfies ClaudeSettings;
    const resolveMaintenance = yield* makeClaudeMaintenanceResolution({
      binaryPath: effectiveConfig.binaryPath,
      env: processEnv,
      npmCacheDir: path.join(host.paths.providerStatusCacheDir, "npm"),
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
    // The SDK's user source is the host's home, not a custom one; same rule as the adapter.
    const customHome =
      effectiveConfig.homePath.trim().length > 0 ||
      processEnv.CLAUDE_CONFIG_DIR !== (yield* HostProcess.Environment).CLAUDE_CONFIG_DIR;
    // Only a successful probe records routes, so a failed one never sends turns back to slugs
    // the backend rejects.
    const modelRoutes = yield* makeClaudeCodeModelRoutes(
      (cwd) =>
        resolveClaudeModelSettingsKey(
          customHome ? ["project", "local"] : ["user", "project", "local"],
          cwd,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      stateDir,
    );
    // Retain reports until the registry subscribes; end its listener on teardown.
    const workspaceRescans = yield* Queue.unbounded<string, Cause.Done>();
    yield* Effect.addFinalizer(() => Queue.end(workspaceRescans));
    // The account whose saved sign-in a model request last rejected.
    const rejectedSignIn = yield* SubscriptionRef.make<
      Pick<ServerProvider["auth"], "email" | "workspaceId"> | undefined
    >(undefined);
    const authenticationUpdates = yield* Semaphore.make(1);
    const inheritedHome = processEnv.CLAUDE_CONFIG_DIR?.trim();
    const canReportSavedLogin =
      !/--settings(?:[=\s]|$)/.test(effectiveConfig.launchArgs) &&
      (effectiveConfig.homePath.trim().length > 0 ||
        !inheritedHome ||
        path.isAbsolute(inheritedHome));
    const withModelAuthentication = (provider: ServerProvider): ServerProvider => {
      const rejected = rejectedSignIn.value;
      const differs = (a: string | undefined, b: string | undefined) =>
        a !== undefined && b !== undefined && a.toLowerCase() !== b.toLowerCase();
      if (
        rejected === undefined ||
        // Another account's rejection says nothing about the one now signed in.
        differs(rejected.email, provider.auth.email) ||
        differs(rejected.workspaceId, provider.auth.workspaceId) ||
        provider.status !== "ready" ||
        provider.auth.type === undefined ||
        provider.auth.type === "apiKey" ||
        provider.auth.type === "bedrock" ||
        provider.auth.type === "customEndpoint"
      )
        return provider;
      // Usage limits and account metadata can still load after a model request returns 401.
      return {
        ...provider,
        status: "warning",
        auth: { ...provider.auth, status: "unknown" },
        modelsRetained: true,
        // No probe can confirm a new sign-in, so this must stay true until a request succeeds.
        message:
          "Claude rejected the saved sign-in on the last request. Run `claude auth login`, then send a message to confirm.",
      };
    };
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
        ...(canReportSavedLogin
          ? {
              onModelAuthentication: Effect.fn("ClaudeDriver.onModelAuthentication")(
                function* (state, cwd) {
                  if (state === "accepted" && rejectedSignIn.value === undefined) return;
                  if (
                    yield* hasClaudeAuthenticationOverride(
                      effectiveConfig,
                      cwd ?? undefined,
                      processEnv,
                    )
                  )
                    return;
                  const auth = (yield* readCurrentSnapshot)?.auth;
                  yield* SubscriptionRef.set(
                    rejectedSignIn,
                    state === "rejected"
                      ? { email: auth?.email, workspaceId: auth?.workspaceId }
                      : undefined,
                  );
                },
                (effect) => authenticationUpdates.withPermit(effect),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            }
          : {}),
        onSessionInit: (cwd) => Queue.offer(workspaceRescans, cwd).pipe(Effect.asVoid),
        modelCatalog,
        routeModelCatalog: modelRoutes.route,
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
      modelRoutes.route,
    );

    // The organization ID comes from Claude's sign-in file, which T3 reads only with usage access.
    const readOrganizationId = usageAccess.pipe(
      Effect.flatMap((allowed) =>
        allowed ? ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath) : Effect.undefined,
      ),
    );
    // Per-instance capabilities cache: keyed on binary + resolved HOME so
    // account-specific probes never share auth metadata across instances.
    // A transient miss may reuse the last account once, but its usage windows keep their age.
    const lastGoodCapabilities = yield* Ref.make<ClaudeCapabilitiesProbe | undefined>(undefined);
    const capabilitiesProbeCache = yield* Cache.makeWith(
      () =>
        probeClaudeCapabilities(effectiveConfig, processEnv, stateDir).pipe(
          Effect.flatMap((capabilities) =>
            readOrganizationId.pipe(
              Effect.map((workspaceId) => ({
                _tag: "fresh" as const,
                capabilities:
                  workspaceId === undefined ? capabilities : { ...capabilities, workspaceId },
              })),
            ),
          ),
          Effect.tap(({ capabilities }) =>
            Ref.set(lastGoodCapabilities, capabilities).pipe(
              Effect.andThen(modelRoutes.record(capabilities.models ?? [])),
            ),
          ),
          Effect.ensuring(modelRoutes.settle),
          Effect.catch((error) =>
            Ref.getAndSet(lastGoodCapabilities, undefined).pipe(
              Effect.flatMap((capabilities) =>
                capabilities === undefined
                  ? Effect.fail(error)
                  : readOrganizationId.pipe(
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
        ),
      {
        capacity: 1,
        timeToLive: (exit) =>
          // Only fresh usage earns the TTL; failures, fallbacks and usage-less probes retry.
          Exit.isSuccess(exit) &&
          exit.value._tag === "fresh" &&
          exit.value.capabilities.usage !== undefined
            ? CAPABILITIES_PROBE_TTL
            : Duration.zero,
      },
    );
    const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
      effectiveConfig,
      stateDir,
      processEnv,
    );
    // A probe holds the organization ID only if access was allowed, so a changed answer probes again.
    const resolveCapabilities = usageAccess.pipe(
      Effect.flatMap((allowed) =>
        Cache.get(capabilitiesProbeCache, `${capabilitiesCacheKey}\0${allowed}`),
      ),
      Effect.map((result) => result.capabilities),
    );

    const checkProvider = catalogService.refreshInBackground.pipe(
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
              // Reset credits need Claude's sign-in token, which T3 reads only with usage access.
              (version) =>
                usageAccess.pipe(
                  Effect.flatMap((allowed) =>
                    allowed
                      ? ClaudeResetCredits.readClaudeResetCredits(configDir, version)
                      : Effect.undefined,
                  ),
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
          Effect.map(stampIdentity),
        ),
      ),
      // Disabled, failed version checks and interruption never reach the probe.
      Effect.ensuring(modelRoutes.settle),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    let readCurrentSnapshot: Effect.Effect<ServerProvider | undefined> = Effect.undefined;
    const checkUsageLimits = Effect.gen(function* () {
      if (!effectiveConfig.enabled) return undefined;
      const current = yield* readCurrentSnapshot;
      const version = current?.version ?? undefined;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const probed = yield* probeClaudeCapabilities(
        effectiveConfig,
        processEnv,
        stateDir,
        "usageOnly",
      ).pipe(Effect.result);
      if (probed._tag === "Failure") {
        return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
      }
      const capabilities = probed.success;
      const usesSavedOAuth =
        Boolean(capabilities.subscriptionType) &&
        !capabilities.apiKeySource &&
        !processEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim();
      const workspaceId = usesSavedOAuth ? yield* readOrganizationId : undefined;
      const auth =
        capabilities.email || workspaceId
          ? {
              ...(capabilities.email ? { email: capabilities.email } : {}),
              ...(workspaceId ? { workspaceId } : {}),
            }
          : undefined;
      const switchedAccount =
        (capabilities.email !== undefined &&
          current?.auth.email !== undefined &&
          capabilities.email.toLowerCase() !== current.auth.email.toLowerCase()) ||
        (workspaceId !== undefined &&
          current?.auth.workspaceId !== undefined &&
          workspaceId !== current.auth.workspaceId);
      if (switchedAccount) {
        yield* Ref.set(lastGoodCapabilities, undefined);
        yield* Cache.invalidateAll(capabilitiesProbeCache);
      }
      if (!capabilities.usage) {
        return {
          usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
          ...(auth ? { auth } : {}),
        };
      }
      const usageLimits = yield* recordClaudeUsageResponse(scopedLimitNames, {
        response: capabilities.usage,
        checkedAt: capabilities.usageCheckedAt ?? checkedAt,
      });
      // Reset credits need Claude's sign-in token, which T3 reads only with usage access.
      const resetCredits =
        usesSavedOAuth && !usageLimits.unavailable && version && (yield* usageAccess)
          ? yield* ClaudeResetCredits.readClaudeResetCredits(configDir, version)
          : undefined;
      return {
        usageLimits: resetCredits ? { ...usageLimits, resetCredits } : usageLimits,
        ...(auth ? { auth } : {}),
      };
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

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
      checkUsageLimits,
      invalidateUsageCache: Cache.invalidateAll(capabilitiesProbeCache),
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.flatMap((enrichedSnapshot) =>
            modelCatalog.pipe(
              Effect.map((catalog) =>
                scopeClaudeUpgradeMessageToChannel(catalog, enrichedSnapshot),
              ),
            ),
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
    readCurrentSnapshot = snapshot.getSnapshot;

    // Same rules as Codex: serialised on the config directory that holds the
    // login, one request id kept until Claude answers (a cooldown or rate
    // limit is an answer), then a re-probe.
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = Effect.fn(
      "ClaudeDriver.consumeResetCredit",
    )(
      function* (creditId) {
        const current = yield* snapshot.getSnapshot;
        const credits = current.usageLimits?.resetCredits;
        const grantId =
          creditId === undefined
            ? credits?.nextCreditId
            : credits?.options?.some((option) => option.creditId === creditId)
              ? creditId
              : undefined;
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
        ResetCreditCoordinator.refreshAfterRedemption({
          outcome,
          getSnapshot: snapshot.getSnapshot,
          refresh: Cache.invalidateAll(capabilitiesProbeCache).pipe(
            Effect.andThen(snapshot.refresh),
          ),
        }).pipe(
          Effect.filterOrFail(
            (confirmed) => confirmed,
            () =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
              }),
          ),
        ),
      ),
    );

    const getSnapshot = snapshot.getSnapshot.pipe(Effect.map(withModelAuthentication));
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
      snapshot: {
        ...snapshot,
        getSnapshot,
        refresh: snapshot.refresh.pipe(Effect.map(withModelAuthentication)),
        streamChanges: Stream.merge(
          snapshot.streamChanges.pipe(Stream.map(withModelAuthentication)),
          SubscriptionRef.changes(rejectedSignIn).pipe(
            // The ref replays its value to each subscriber. Before the first check that would
            // publish the placeholder over the cached status the registry is showing.
            Stream.filterEffect(() =>
              Effect.map(
                snapshot.isAwaitingFirstCheck ?? Effect.succeed(false),
                (awaiting) => !awaiting,
              ),
            ),
            Stream.mapEffect(() => getSnapshot),
          ),
        ),
      },
      invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
      workspaceRescans: Stream.fromQueue(workspaceRescans),
      // Unreadable settings report no limit; the thread's own notice covers a refused mode.
      runtimeModeLimitsForCwd: (cwd: string) =>
        resolveClaudeModeAvailability({
          settings: effectiveConfig,
          homePath: configDir,
          customHome,
          cwd,
          fileSystem,
          path,
        }).pipe(
          Effect.map((availability) =>
            availability.autoDisabledBy === undefined
              ? []
              : [{ mode: "auto" as const, reason: availability.autoDisabledBy }],
          ),
          Effect.orElseSucceed(() => []),
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        ),
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
