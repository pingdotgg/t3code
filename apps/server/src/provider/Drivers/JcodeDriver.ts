import { JcodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeJcodeTextGeneration } from "../../textGeneration/JcodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeJcodeAdapter } from "../Layers/JcodeAdapter.ts";
import {
  buildInitialJcodeProviderSnapshot,
  checkJcodeProviderStatus,
  enrichJcodeSnapshot,
} from "../Layers/JcodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { discoverJcodeSkills } from "./JcodeSkills.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeJcodeSettings = Schema.decodeSync(JcodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("jcode");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type JcodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const JcodeDriver: ProviderDriver<JcodeSettings, JcodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Jcode",
    supportsMultipleInstances: true,
  },
  configSchema: JcodeSettings,
  defaultConfig: (): JcodeSettings => decodeJcodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
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
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies JcodeSettings;
      const adapter = yield* makeJcodeAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeJcodeTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkJcodeProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<JcodeSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialJcodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichJcodeSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Jcode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Skill discovery is cwd-scoped (project skills live under
      // `<cwd>/.jcode/skills`), so the registry asks per workspace like the
      // Grok and Claude drivers do. Failures surface as driver errors; the
      // registry keeps the provider visible while it retries.
      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverJcodeSkills({
                homePath: effectiveConfig.homePath,
                cwd: workspaceCwd,
              }),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
