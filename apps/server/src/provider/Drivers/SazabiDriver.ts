/**
 * SazabiDriver — `ProviderDriver` for the Sazabi **cloud** provider.
 *
 * Scaffold only (PR T1). Mirrors the Grok / OpenCode drivers: a plain value
 * whose `create()` bundles `snapshot` / `adapter` / `textGeneration` closures
 * over the per-instance `SazabiSettings`.
 *
 * Sazabi is Path A (cloud): the adapter will talk to the Sazabi public API
 * over HTTP/SSE. This scaffold wires up an availability probe (token/env or an
 * optional `sazabi whoami`) and an "empty" adapter whose `streamEvents` PubSub
 * is ready for PR T2 to fill in with real streaming + cancel. The driver is
 * fully constructable at boot so the provider surfaces in the catalog + settings
 * and reports a clear reason when unauthenticated.
 *
 * @module provider/Drivers/SazabiDriver
 */
import { SazabiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeSazabiTextGeneration } from "../../textGeneration/SazabiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeSazabiAdapter } from "../Layers/SazabiAdapter.ts";
import {
  buildInitialSazabiProviderSnapshot,
  checkSazabiProviderStatus,
} from "../Layers/SazabiProvider.ts";
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

const decodeSazabiSettings = Schema.decodeSync(SazabiSettings);

const DRIVER_KIND = ProviderDriverKind.make("sazabi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

// Cloud provider: no local package/binary to self-update. Manual only.
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type SazabiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
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

export const SazabiDriver: ProviderDriver<SazabiSettings, SazabiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Sazabi",
    supportsMultipleInstances: true,
  },
  configSchema: SazabiSettings,
  defaultConfig: (): SazabiSettings => decodeSazabiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      const effectiveConfig = { ...config, enabled } satisfies SazabiSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeSazabiAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeSazabiTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkSazabiProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<SazabiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialSazabiProviderSnapshot(settings.provider, processEnv).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Sazabi snapshot: ${cause.message ?? String(cause)}`,
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
