import { TextGenerationError } from "@t3tools/contracts";
import { FxSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { type FxAdapterV2DriverEnv, makeFxAdapterV2Driver } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialFxProviderSnapshot,
  checkFxProviderStatus,
  fxDefaultModelId,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { discoverFxSkills } from "./skills.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { FX_DRIVER_KIND } from "./acpSupport.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
// fx installs from its own setup script and updates with `fx upgrade`; there
// is no npm package to read a latest version from.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: FX_DRIVER_KIND,
  packageName: null,
});

// See `supportsTextGeneration` in status.ts.
const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "fx does not provide application text generation.",
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

export type FxDriverEnv =
  | FxAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost;

export const FxDriver: ProviderDriver<FxSettings, FxDriverEnv> = {
  driverKind: FX_DRIVER_KIND,
  metadata: {
    displayName: "fx",
    supportsMultipleInstances: true,
  },
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => decodeFxSettings({}),
  create: Effect.fn("FxDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: FX_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: FX_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies FxSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FxSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialFxProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkFxProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: FX_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the fx provider snapshot.",
            cause,
          }),
      ),
    );

    // "Default" selects the model the snapshot read from `fx status`.
    const orchestrationAdapter = yield* makeFxAdapterV2Driver(
      snapshot.getSnapshot.pipe(Effect.map((current) => fxDefaultModelId(current.models))),
    )
      .create({ instanceId, displayName, accentColor, environment, enabled, config })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: FX_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the fx orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: FX_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverFxSkills({ cwd, environment: processEnv }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
