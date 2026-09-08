import { HarnessSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeHarnessTextGeneration } from "../../textGeneration/HarnessTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHarnessAdapter } from "../Layers/HarnessAdapter.ts";
import {
  checkHarnessProviderStatus,
  makePendingHarnessProvider,
} from "../Layers/HarnessProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeHarnessSettings = Schema.decodeSync(HarnessSettings);

const DRIVER_KIND = ProviderDriverKind.make("harness");

export type HarnessDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | HttpClient.HttpClient
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

export const HarnessDriver: ProviderDriver<HarnessSettings, HarnessDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Harness",
    supportsMultipleInstances: true,
  },
  configSchema: HarnessSettings,
  defaultConfig: (): HarnessSettings => decodeHarnessSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
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
      const effectiveConfig = { ...config, enabled } satisfies HarnessSettings;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const adapter = yield* makeHarnessAdapter(effectiveConfig, { instanceId });
      const textGeneration = yield* makeHarnessTextGeneration(effectiveConfig);

      const checkProvider = checkHarnessProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<HarnessSettings>>({
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingHarnessProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) => publishSnapshot(snapshot),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Harness snapshot: ${cause.message ?? String(cause)}`,
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
