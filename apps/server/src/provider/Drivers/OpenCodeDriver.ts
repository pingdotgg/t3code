/**
 * OpenCodeDriver — `ProviderDriver` for the OpenCode runtime.
 *
 * Mirrors the Codex / Claude drivers: a plain value whose `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the
 * per-instance `OpenCodeSettings`.
 *
 * Two instances with different `serverUrl`s therefore talk to independent
 * OpenCode servers; when no `serverUrl` is set, the adapter + text-generation
 * shares spin up their own scoped child processes, and those child
 * processes are released when the registry scope closes.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import { OpenCodeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  listOpenCodeProjectSlashCommands,
  makePendingOpenCodeProvider,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { makeProviderProjectCapabilitiesError } from "../projectCapabilities.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const PROJECT_CAPABILITIES_TTL = Duration.seconds(30);

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  homebrewFormula: "anomalyco/tap/opencode",
  nativeUpdate: {
    executable: "opencode",
    args: ["upgrade"],
    lockKey: "opencode-native",
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

export type OpenCodeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeOpenCodeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(effectiveConfig, processEnv);
      const projectSlashCommandCache = yield* Cache.makeWith(
        (cwd: string) =>
          listOpenCodeProjectSlashCommands(effectiveConfig, cwd, processEnv).pipe(
            Effect.provideService(OpenCodeRuntime, openCodeRuntime),
          ),
        {
          capacity: 64,
          timeToLive: () => PROJECT_CAPABILITIES_TTL,
        },
      );

      const checkProvider = checkOpenCodeProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        composerCapabilities: {
          list: (input) =>
            Effect.gen(function* () {
              const slashCommands = input.forceReload
                ? yield* listOpenCodeProjectSlashCommands(
                    effectiveConfig,
                    input.cwd,
                    processEnv,
                  ).pipe(Effect.provideService(OpenCodeRuntime, openCodeRuntime))
                : yield* Cache.get(projectSlashCommandCache, input.cwd);
              return {
                providerInstanceId: instanceId,
                cwd: input.cwd,
                slashCommands,
                skills: [],
              };
            }).pipe(
              Effect.mapError((cause) =>
                makeProviderProjectCapabilitiesError({
                  provider: DRIVER_KIND,
                  instanceId,
                  cwd: input.cwd,
                  cause,
                }),
              ),
            ),
        },
      } satisfies ProviderInstance;
    }),
};
