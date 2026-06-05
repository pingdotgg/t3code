/**
 * HermesDriver — `ProviderDriver` for the Hermes Agent (`hermes`) runtime.
 *
 * Hermes exposes an ACP-based CLI. The driver is still a plain value, but
 * its snapshot uses `makeManagedServerProvider`'s optional `enrichSnapshot`
 * hook to run the slow ACP model-capability probe in the background without
 * blocking the initial `ready`-state publish.
 *
 * Text generation is supported via the ACP runtime — `makeHermesTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/HermesDriver
 */
import { HermesSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  enrichHermesSnapshot,
} from "../Layers/HermesProvider.ts";
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
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
    updateExecutable: "hermes",
    updateArgs: ["update"],
    updateLockKey: "hermes-agent",
  }),
);

export type HermesDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

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

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
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
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeHermesAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeHermesTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkHermesProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<HermesSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildInitialHermesProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        // Keep version-advisory enrichment off the initial provider snapshot
        // so Hermes never blocks server startup or settings rendering.
        enrichSnapshot: ({ settings: _settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichHermesSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            publishSnapshot,
            stampIdentity,
            httpClient,
          }),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Hermes snapshot: ${cause.message ?? String(cause)}`,
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
      } satisfies ProviderInstance;
    }),
};
