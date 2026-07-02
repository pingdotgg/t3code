import { DevinSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDevinTextGeneration } from "../../textGeneration/DevinTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  enrichDevinSnapshot,
} from "../Layers/DevinProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeProviderModelDiscoveryCache } from "../ProviderModelDiscoveryCache.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderModelMergePolicy,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { isDevinAcpModelCoveredByBaseModelIds } from "../acp/DevinAcpSupport.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const DRIVER_KIND = ProviderDriverKind.make("devin");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export const DEVIN_MODEL_MERGE_POLICY: ProviderModelMergePolicy = {
  shouldCarryPreviousModel: ({ previousModel, nextModelSlugs }) => {
    if (nextModelSlugs.has(previousModel.slug)) {
      return false;
    }
    return !isDevinAcpModelCoveredByBaseModelIds({
      modelId: previousModel.slug,
      modelName: previousModel.name,
      baseModelIds: nextModelSlugs,
    });
  },
};

export type DevinDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
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

export const DevinDriver: ProviderDriver<DevinSettings, DevinDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Devin",
    supportsMultipleInstances: true,
  },
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => decodeDevinSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      const effectiveConfig = { ...config, enabled } satisfies DevinSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const modelDiscoveryCache = yield* makeProviderModelDiscoveryCache();

      const adapter = yield* makeDevinAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onSessionModelsDiscovered: modelDiscoveryCache.recordModels,
      });
      const textGeneration = yield* makeDevinTextGeneration(effectiveConfig, processEnv);

      const checkProvider = modelDiscoveryCache.getModels.pipe(
        Effect.flatMap((cachedDiscoveredModels) =>
          checkDevinProviderStatus(effectiveConfig, processEnv, { cachedDiscoveredModels }),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DevinSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialDevinProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichDevinSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Devin snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      yield* modelDiscoveryCache.setRefresh(snapshot.refresh);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        modelMergePolicy: DEVIN_MODEL_MERGE_POLICY,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
