import { TextGenerationError } from "@t3tools/contracts";
import { SparrowSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { SPARROW_DRIVER_KIND } from "./acpSupport.ts";
import { makeSparrowAdapterV2Driver, type SparrowAdapterV2DriverEnv } from "./adapter.ts";
import { discoverSparrowSkills, discoverSparrowSlashCommands } from "./skills.ts";
import { buildInitialSparrowProviderSnapshot, checkSparrowProviderStatus } from "./status.ts";

const decodeSparrowSettings = Schema.decodeSync(SparrowSettings);

const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: SPARROW_DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Sparrow does not provide application text generation.",
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

export type SparrowDriverEnv =
  | SparrowAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost;

export const SparrowDriver: ProviderDriver<SparrowSettings, SparrowDriverEnv> = {
  driverKind: SPARROW_DRIVER_KIND,
  metadata: {
    displayName: "Sparrow",
    supportsMultipleInstances: true,
  },
  configSchema: SparrowSettings,
  defaultConfig: (): SparrowSettings => decodeSparrowSettings({}),
  create: Effect.fn("SparrowDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* SecureRandom.SecureRandom;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: SPARROW_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: SPARROW_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, homeDirectory),
      homePath: config.homePath ? expandHomePath(config.homePath, homeDirectory) : "",
    } satisfies SparrowSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<SparrowSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialSparrowProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkSparrowProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: SPARROW_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Sparrow provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* makeSparrowAdapterV2Driver()
      .create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfig,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: SPARROW_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Sparrow orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: SPARROW_DRIVER_KIND,
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
              discoverSparrowSkills({
                cwd,
                settings: effectiveConfig,
                environment: processEnv,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
              discoverSparrowSlashCommands({
                cwd,
                settings: effectiveConfig,
                environment: processEnv,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, skills, slashCommands]) => ({
                ...machineSnapshot,
                skills,
                slashCommands,
              })),
            ),
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
