import { TextGenerationError } from "@t3tools/contracts";
import { OpenRigSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { type OpenRigAdapterV2DriverEnv, makeOpenRigAdapterV2Driver } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { buildInitialOpenRigProviderSnapshot, checkOpenRigProviderStatus } from "./status.ts";
import { OPENRIG_DRIVER_KIND } from "./acpSupport.ts";

const decodeOpenRigSettings = Schema.decodeSync(OpenRigSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: OPENRIG_DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "OpenRig does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
})();

export type OpenRigDriverEnv =
  | OpenRigAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | ProviderHost.ProviderHost;

export const OpenRigDriver: ProviderDriver<OpenRigSettings, OpenRigDriverEnv> = {
  driverKind: OPENRIG_DRIVER_KIND,
  metadata: {
    displayName: "OpenRig",
    supportsMultipleInstances: true,
  },
  configSchema: OpenRigSettings,
  defaultConfig: (): OpenRigSettings => decodeOpenRigSettings({}),
  create: Effect.fn("OpenRigDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: OPENRIG_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: OPENRIG_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies OpenRigSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenRigSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOpenRigProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkOpenRigProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OPENRIG_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the OpenRig provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* makeOpenRigAdapterV2Driver()
      .create({ instanceId, displayName, accentColor, environment, enabled, config })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OPENRIG_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the OpenRig orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: OPENRIG_DRIVER_KIND,
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
