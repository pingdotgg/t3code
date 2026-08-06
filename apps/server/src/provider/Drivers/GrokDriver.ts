import { GrokSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
  ensureGrokStaticSlashCommands,
  mapAcpCommandsToCatalog,
} from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
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
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type GrokDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
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

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
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
      const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const commandCatalogRef = yield* Ref.make({
        received: false,
        slashCommands: [] as ServerProvider["slashCommands"],
        skills: [] as ServerProvider["skills"],
      });
      // Live available_commands_update (and initialize meta seed) must push a
      // snapshot change so clients do not wait for the next health probe.
      const commandCatalogChanges = yield* Effect.acquireRelease(
        PubSub.unbounded<void>(),
        PubSub.shutdown,
      );

      const mergeCommandCatalog = (snapshot: ServerProvider): Effect.Effect<ServerProvider> =>
        Ref.get(commandCatalogRef).pipe(
          Effect.map((catalog) => {
            // Until a live catalog arrives, keep discovery/probe catalogs on the snapshot.
            if (!catalog.received) {
              return {
                ...snapshot,
                slashCommands: ensureGrokStaticSlashCommands(snapshot.slashCommands),
              };
            }
            // Once received, apply even when empty so clients clear stale entries,
            // but always re-attach static commands (e.g. compact) if missing.
            return {
              ...snapshot,
              slashCommands: ensureGrokStaticSlashCommands(catalog.slashCommands),
              skills: catalog.skills,
            };
          }),
        );

      const adapter = yield* makeGrokAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        onAvailableCommands: (commands) =>
          Effect.gen(function* () {
            const catalog = mapAcpCommandsToCatalog(commands);
            yield* Ref.set(commandCatalogRef, {
              received: true,
              slashCommands: ensureGrokStaticSlashCommands(catalog.slashCommands),
              skills: catalog.skills,
            });
            yield* PubSub.publish(commandCatalogChanges, undefined);
          }),
      });
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkGrokProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.flatMap(mergeCommandCatalog),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const managedSnapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<GrokSettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGrokProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
            Effect.flatMap(mergeCommandCatalog),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichGrokSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
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
              detail: `Failed to build Grok snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const snapshot = {
        ...managedSnapshot,
        getSnapshot: managedSnapshot.getSnapshot.pipe(Effect.flatMap(mergeCommandCatalog)),
        get streamChanges() {
          const managedChanges = Stream.mapEffect(
            managedSnapshot.streamChanges,
            mergeCommandCatalog,
          );
          const catalogDrivenChanges = Stream.mapEffect(
            Stream.fromPubSub(commandCatalogChanges),
            () => managedSnapshot.getSnapshot.pipe(Effect.flatMap(mergeCommandCatalog)),
          );
          return Stream.merge(managedChanges, catalogDrivenChanges);
        },
      };

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
      } satisfies ProviderInstance;
    }),
};
