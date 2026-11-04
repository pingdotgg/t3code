import { TextGenerationError } from "@t3tools/contracts";
import { VibeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { type VibeAdapterV2DriverEnv, VibeAdapterV2Driver } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { buildInitialVibeProviderSnapshot, checkVibeProviderStatus } from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { VIBE_DRIVER_KIND } from "./acpSupport.ts";

const decodeVibeSettings = Schema.decodeSync(VibeSettings);
// Vibe installs and updates through uv or its own installer; there is no npm
// package to read a latest version from.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: VIBE_DRIVER_KIND,
  packageName: null,
});

// See `supportsTextGeneration` in status.ts.
const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Mistral Vibe does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export type VibeDriverEnv = VibeAdapterV2DriverEnv;

export const VibeDriver: ProviderDriver<VibeSettings, VibeDriverEnv> = {
  driverKind: VIBE_DRIVER_KIND,
  metadata: {
    displayName: "Mistral Vibe",
    supportsMultipleInstances: true,
  },
  configSchema: VibeSettings,
  defaultConfig: (): VibeSettings => decodeVibeSettings({}),
  create: Effect.fn("VibeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* SecureRandom.SecureRandom;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: VIBE_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: VIBE_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies VibeSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<VibeSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialVibeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkVibeProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: VIBE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Mistral Vibe provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* VibeAdapterV2Driver.create({
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
            driver: VIBE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Mistral Vibe orchestration adapter.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: VIBE_DRIVER_KIND,
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
