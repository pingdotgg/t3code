import { KimiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { resolveKimiBinaryPath } from "../acp/KimiAcpSupport.ts";
import { makeKimiAdapter } from "../Layers/KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  enrichKimiSnapshot,
} from "../Layers/KimiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

export const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type KimiDriverEnv =
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
    driver: KIMI_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: KIMI_DRIVER_KIND,
  metadata: {
    displayName: "Kimi Code",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: KIMI_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KimiSettings;
      const resolvedKimiCommand = yield* resolveKimiBinaryPath(effectiveConfig, processEnv);
      // Thread the resolved command back through the config handed to the
      // adapter, text generation, and status probe. When resolution found a
      // concrete path (e.g. the ~/.kimi-code/bin fallback), downstream
      // resolveKimiBinaryPath calls take the explicit-path fast path instead
      // of rescanning PATH on every spawn. When resolution fell through to
      // the bare "kimi" default, downstream calls keep re-resolving, so a
      // later install is still picked up by the periodic status refresh.
      const resolvedConfig = {
        ...effectiveConfig,
        binaryPath: resolvedKimiCommand,
      } satisfies KimiSettings;
      // Provider maintenance (`kimi upgrade`) is spawned from the server's own
      // environment, not this instance's ProviderInstanceEnvironment. A bare
      // "kimi" executable (found only via the instance-augmented PATH) would
      // fail command-not-found there, so pin the maintenance command to an
      // absolute path resolved with the instance environment while it is still
      // in scope. If the CLI can't be resolved (not installed), fall back to
      // the bare command — maintenance can't run in that state anyway.
      const kimiUpdateExecutable = yield* resolveCommandPath(resolvedKimiCommand, {
        env: processEnv,
      }).pipe(Effect.catchTags({ CommandResolutionError: () => Effect.succeed(resolvedKimiCommand) }));
      const update = makeStaticProviderMaintenanceResolver(
        makeProviderMaintenanceCapabilities({
          provider: KIMI_DRIVER_KIND,
          packageName: null,
          updateExecutable: kimiUpdateExecutable,
          updateArgs: ["upgrade"],
          updateLockKey: "kimi-code",
        }),
      );
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(update, {
        binaryPath: resolvedKimiCommand,
        env: processEnv,
      });

      const adapter = yield* makeKimiAdapter(resolvedConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeKimiTextGeneration(resolvedConfig, processEnv);

      const checkProvider = checkKimiProviderStatus(resolvedConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KimiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKimiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichKimiSnapshot({
            settings: settings.provider,
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
              driver: KIMI_DRIVER_KIND,
              instanceId,
              detail: "Failed to build Kimi Code snapshot: " + (cause.message ?? String(cause)),
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: KIMI_DRIVER_KIND,
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
