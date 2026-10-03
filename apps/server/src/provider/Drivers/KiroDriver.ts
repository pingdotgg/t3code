import { KiroSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import {
  KiroAdapterV2Driver,
  type KiroAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/KiroAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
} from "../Layers/KiroProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("kiro");
const decodeKiroSettings = Schema.decodeSync(KiroSettings);
// Kiro updates itself in the background (`kiro-cli update` reports only), so
// T3 offers no one-click update.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration: TextGeneration["Service"] = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Kiro does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
})();

export type KiroDriverEnv =
  | KiroAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerSettings.ServerSettingsService;

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(
        environment,
        yield* HostProcessEnvironment,
      );
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
      const effectiveConfig = { ...config, enabled } satisfies KiroSettings;
      const orchestrationAdapter = yield* KiroAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Kiro orchestration adapter.",
              cause,
            }),
        ),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKiroProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkKiroProviderStatus(effectiveConfig, processEnv).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              // The cause keeps the failure; the detail reaches the snapshot, so it stays fixed.
              detail: "Failed to build Kiro snapshot.",
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
        orchestrationAdapter,
        textGeneration: unsupportedTextGeneration,
      } satisfies ProviderInstance;
    }),
};
