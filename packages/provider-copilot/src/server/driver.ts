import { ProviderDriverKind } from "@t3tools/contracts";
import { GitHubCopilotSettings } from "../settings.ts";
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
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { GitHubCopilotAdapterV2Driver, type GitHubCopilotAdapterV2DriverEnv } from "./adapter.ts";
import {
  buildInitialGitHubCopilotProviderSnapshot,
  checkGitHubCopilotProviderStatus,
} from "./status.ts";
import { makeGitHubCopilotTextGeneration } from "./textGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("githubCopilot");
const decodeSettings = Schema.decodeSync(GitHubCopilotSettings);
// The Copilot CLI updates itself, so T3 offers no one-click update.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type GitHubCopilotDriverEnv =
  | GitHubCopilotAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | ProviderHost.ProviderHost;

export const GitHubCopilotDriver: ProviderDriver<GitHubCopilotSettings, GitHubCopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: GitHubCopilotSettings,
  defaultConfig: (): GitHubCopilotSettings => decodeSettings({}),
  create: Effect.fn("GitHubCopilotDriver.create")(function* ({
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
    const effectiveConfig = { ...config, enabled } satisfies GitHubCopilotSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<GitHubCopilotSettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialGitHubCopilotProviderSnapshot(settings.provider).pipe(
          Effect.map(stampIdentity),
        ),
      checkProvider: checkGitHubCopilotProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            // The cause keeps the failure; the detail reaches the snapshot, so it stays fixed.
            detail: "Failed to build GitHub Copilot snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* GitHubCopilotAdapterV2Driver.create({
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
            detail: "Failed to build GitHub Copilot orchestration adapter.",
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
      textGeneration: makeGitHubCopilotTextGeneration({
        settings: effectiveConfig,
        environment: processEnv,
        fileSystem,
        path,
      }),
    } satisfies ProviderInstance;
  }),
};
