import { AuggieSettings, ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAuggieTextGeneration } from "../../textGeneration/AuggieTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAuggieAdapter } from "../Layers/AuggieAdapter.ts";
import {
  buildInitialAuggieProviderSnapshot,
  checkAuggieProviderStatus,
  enrichAuggieSnapshot,
} from "../Layers/AuggieProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeAuggieSettings = Schema.decodeSync(AuggieSettings);

const DRIVER_KIND = ProviderDriverKind.make("auggie");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@augmentcode/auggie",
});

export type AuggieDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const sameModelSlugs = (
  left: ReadonlyArray<ServerProviderModel>,
  right: ReadonlyArray<ServerProviderModel>,
): boolean =>
  left.length === right.length && left.every((model, index) => model.slug === right[index]?.slug);

export const AuggieDriver: ProviderDriver<AuggieSettings, AuggieDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Auggie",
    supportsMultipleInstances: true,
  },
  configSchema: AuggieSettings,
  defaultConfig: (): AuggieSettings => decodeAuggieSettings({}),
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
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies AuggieSettings;

      // Auggie only advertises its catalog on session setup, so the probe
      // cannot discover models without creating a session — which would index
      // the workspace as a side effect of a health check. Instead the adapter
      // reports what a real session saw, the probe folds it into the snapshot,
      // and `providerStatusCache` carries it across restarts.
      const discoveredModelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
      const refreshSnapshotRef = yield* Ref.make<Effect.Effect<unknown> | null>(null);

      const adapter = yield* makeAuggieAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onModelsDiscovered: (models) =>
          Effect.gen(function* () {
            const changed = yield* Ref.modify(discoveredModelsRef, (current) =>
              sameModelSlugs(current, models)
                ? ([false, current] as const)
                : ([true, models] as const),
            );
            if (!changed) return;
            const refresh = yield* Ref.get(refreshSnapshotRef);
            if (refresh) {
              yield* Effect.ignore(refresh);
            }
          }),
      });
      const textGeneration = makeAuggieTextGeneration();

      const checkProvider = Effect.gen(function* () {
        const snapshot = yield* checkAuggieProviderStatus(effectiveConfig, processEnv);
        const discovered = yield* Ref.get(discoveredModelsRef);
        if (discovered.length === 0) {
          return snapshot;
        }
        // Discovered models replace the sentinel-only list; custom models from
        // settings are preserved because the probe already merged them in.
        const customModels = snapshot.models.filter((model) => model.isCustom);
        return { ...snapshot, models: [...discovered, ...customModels] };
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<AuggieSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialAuggieProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichAuggieSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Auggie snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      yield* Ref.set(refreshSnapshotRef, snapshot.refresh);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        // No `refreshModels`: the catalog only exists inside a live session, so
        // there is nothing this could refresh. The RPC skips instances without it.
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
