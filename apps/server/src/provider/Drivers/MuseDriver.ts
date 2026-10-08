import { MuseSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapterV2 } from "../../orchestration-v2/Adapters/MuseAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { checkMuseProviderStatus, makePendingMuseProvider } from "../MuseProvider.ts";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { enrichMuseSnapshot, latestMuseVersion, museMaintenance } from "../museMaintenance.ts";
import { makeMuseEnvironment } from "../museSdk.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

export type MuseDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeMuseSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const host = yield* ProviderHost;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const { cwd } = serverConfig;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const hostEnvironment = yield* HostProcessEnvironment;
      // Drop an inherited META_API_KEY so Muse uses its login; an instance value still wins.
      const processEnvironment = mergeProviderInstanceEnvironment(
        environment,
        makeMuseEnvironment(hostEnvironment),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies MuseSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
      const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnvironment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        Effect.gen(function* () {
          const capabilities = yield* resolveInstallation(options);
          // The maintenance runner requests fresh capabilities around an explicit update
          // and needs the native target version to verify that the command actually upgraded.
          const latestVersion = options?.fresh
            ? yield* latestMuseVersion(processEnvironment, { fresh: true }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
              )
            : undefined;
          return latestVersion !== undefined ? { ...capabilities, latestVersion } : capabilities;
        });
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingMuseProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkMuseProviderStatus(effectiveConfig, processEnvironment, cwd).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichMuseSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                environment: processEnvironment,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Muse Code snapshot.",
              cause,
            }),
        ),
      );
      const modelCatalog = snapshot.getSnapshot.pipe(Effect.map((current) => current.models));
      const orchestrationAdapter = makeMuseAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: processEnvironment,
        idAllocator,
        serverConfig,
        fileSystem,
        modelCatalog,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        continuationRequests,
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, {
        environment: processEnvironment,
        modelCatalog,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
