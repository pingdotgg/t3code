/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
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
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const host = yield* ProviderHost;
      const catalogService = yield* ModelCatalog.ModelCatalog;
      const modelCatalog = catalogService
        .current(DRIVER_KIND)
        .pipe(Effect.map(resolveClaudeModelCatalog));
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies ClaudeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
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
        { scopedLimitNames, onUsageLimits: (update) => snapshot.applyUsageLimits(update) },
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

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        cwd,
        processEnv,
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = catalogService.refreshInBackground.pipe(
        Effect.andThen(
          modelCatalog.pipe(
            Effect.flatMap((catalog) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
                processEnv,
                cwd,
                catalog,
                scopedLimitNames,
                (version) =>
                  ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                    Effect.provideService(HttpClient.HttpClient, httpClient),
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  ),
              ),
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
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
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
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
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        Effect.gen(function* () {
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
              }),
            ClaudeResetCredits.isSettledClaudeResetCreditFailure,
          );
        }).pipe(
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
          // Re-probe after any answer, but only a reset claims the limits
          // changed, so only a reset reports an unconfirmed refresh.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
              yield* Cache.invalidateAll(capabilitiesProbeCache);
              const refreshed = yield* snapshot.refresh;
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
