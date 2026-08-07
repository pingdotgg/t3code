/**
 * OpenClawDriver — `ProviderDriver` for the OpenClaw gateway.
 *
 * Mirrors the OpenCode driver: a plain value whose `create()` bundles
 * `snapshot` / `adapter` / `textGeneration` closures over the per-instance
 * `OpenClawSettings`.
 *
 * OpenClaw is server-backed — one gateway per instance hosts every session —
 * so `create()` builds a shared {@link OpenClawGatewayHolder} (spawn-or-connect,
 * lazy) that both the adapter and text generation use. The holder's process
 * lifetime is bound to `gatewayScope`, which the registry's scope closes when
 * the instance is torn down.
 *
 * @module provider/Drivers/OpenClawDriver
 */
import { OpenClawSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenClawTextGeneration } from "../../textGeneration/OpenClawTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenClawAdapter, makeOpenClawGatewayHolder } from "../Layers/OpenClawAdapter.ts";
import {
  checkOpenClawProviderStatus,
  makePendingOpenClawProvider,
} from "../Layers/OpenClawProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenClawRuntime } from "../openclawRuntime.ts";
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
const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);

const DRIVER_KIND = ProviderDriverKind.make("openclaw");
// OpenClaw ships as an npm global; updates stay manual (no reliable update
// command), but the advisory shows the installed version.
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "openclaw",
  }),
);

export type OpenClawDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenClawRuntime
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

export const OpenClawDriver: ProviderDriver<OpenClawSettings, OpenClawDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenClaw",
    supportsMultipleInstances: true,
  },
  configSchema: OpenClawSettings,
  defaultConfig: (): OpenClawSettings => decodeOpenClawSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const path = yield* Path.Path;
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
      const effectiveConfig = { ...config, enabled } satisfies OpenClawSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      // One gateway per instance, shared by the adapter and text generation.
      // The scope owns the spawned gateway process; closing it on teardown
      // kills the child and interrupts the event pump.
      const gatewayScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(gatewayScope, Exit.void).pipe(Effect.ignore));
      const gateway = yield* makeOpenClawGatewayHolder(gatewayScope);

      // Spawned gateways get an isolated state dir under the T3 instance state
      // so they never touch a user's `~/.openclaw`.
      const stateDir = path.join(serverConfig.stateDir, "providers", "openclaw", instanceId);

      const adapter = yield* makeOpenClawAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        stateDir,
        gateway,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenClawTextGeneration(effectiveConfig, {
        gateway,
        environment: processEnv,
      });

      const openClawRuntime = yield* OpenClawRuntime;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const checkProvider = checkOpenClawProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(OpenClawRuntime, openClawRuntime),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenClawSettings>>(
        {
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingOpenClawProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenClaw snapshot: ${cause.message ?? String(cause)}`,
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
