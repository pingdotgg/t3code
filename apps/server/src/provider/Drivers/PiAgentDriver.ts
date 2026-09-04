/**
 * Early Access Pi Agent driver.
 *
 * Pi is a user-managed executable and a profile can be configured more than
 * once. Each instance owns its adapter, profile environment, RPC sessions,
 * dynamic catalog, and continuation identity; no process or catalog state is
 * shared with another instance.
 */
import { PiAgentSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  checkPiAgentProviderStatus,
  discoverPiAgentCatalog,
  makePendingPiAgentProvider,
  providerModelsFromPiCatalog,
} from "../Layers/PiAgentProvider.ts";
import { makePiAgentAdapter } from "../Layers/PiAgentAdapter.ts";
import { makePiRpcClient } from "../pi/PiRpcClient.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
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
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("piAgent");
const decodePiAgentSettings = Schema.decodeSync(PiAgentSettings);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
);

/** Keep instance-level profile paths stable across projects and Usage scans. */
export function resolvePiAgentSettingsPaths(
  config: PiAgentSettings,
  serverRoot: string,
  resolvePath: (path: string, ...paths: ReadonlyArray<string>) => string,
): PiAgentSettings {
  const resolveDirectory = (value: string) => {
    const configured = value.trim();
    return configured ? resolvePath(serverRoot, expandHomePath(configured)) : "";
  };
  return {
    ...config,
    agentDir: resolveDirectory(config.agentDir),
    sessionDir: resolveDirectory(config.sessionDir),
  };
}

export type PiAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

const unsupportedTextGeneration = <Operation extends string>(operation: Operation) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Pi Agent does not support T3 Code structured text generation.",
    }),
  );

function makeUnsupportedTextGeneration(): TextGeneration["Service"] {
  return {
    generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
    generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
    generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
    generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
  };
}

/** Services required by the Pi driver. */
export const PiAgentDriver: ProviderDriver<PiAgentSettings, PiAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi Agent",
    supportsMultipleInstances: true,
  },
  configSchema: PiAgentSettings,
  defaultConfig: () => decodePiAgentSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = resolvePiAgentSettingsPaths(
        { ...config, enabled },
        serverConfig.cwd,
        path.resolve,
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
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnvironment,
      });

      const adapter = yield* makePiAgentAdapter(effectiveConfig, {
        instanceId,
        makeClient: (options) =>
          makePiRpcClient({
            ...options,
            env: {
              ...Object.fromEntries(
                Object.entries(processEnvironment).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              ...options.env,
            },
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ServerConfig, serverConfig),
      );

      const checkProvider = checkPiAgentProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnvironment,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiAgentSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingPiAgentProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi Agent snapshot: ${cause.message ?? String(cause)}`,
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
        snapshotForCwd: (cwd: string) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                discoverPiAgentCatalog(effectiveConfig, cwd, processEnvironment).pipe(
                  Effect.timeout("12 seconds"),
                  Effect.scoped,
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                ),
              ]).pipe(
                Effect.map(([machineSnapshot, catalog]) => ({
                  ...machineSnapshot,
                  models:
                    catalog.models.length > 0
                      ? providerModelsFromPiCatalog(catalog.models, effectiveConfig.customModels)
                      : machineSnapshot.models,
                  slashCommands: catalog.slashCommands,
                  skills: catalog.skills,
                })),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Pi Agent metadata for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
