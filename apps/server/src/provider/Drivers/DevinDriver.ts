import { DevinSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDevinTextGeneration } from "../../textGeneration/DevinTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import { checkDevinProviderStatus, makeDevinProvider } from "../Layers/DevinProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeDevinAcpRuntime } from "../acp/DevinAcpSupport.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const DRIVER_KIND = ProviderDriverKind.make("devin");

// `devin update` self-updates, so the resolved executable is its own updater.
// No executable means nothing to update, not "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "devin",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
    ),
};

export type DevinDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const DevinDriver: ProviderDriver<DevinSettings, DevinDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Devin",
    supportsMultipleInstances: true,
  },
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => decodeDevinSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
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
      const effectiveConfig = { ...config, enabled } satisfies DevinSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const provider = yield* makeDevinProvider(effectiveConfig, {
        stampIdentity,
        resolveMaintenance,
        probe: checkDevinProviderStatus(effectiveConfig, processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      });

      const adapter = yield* makeDevinAdapter(effectiveConfig, {
        instanceId,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onSessionStarted: provider.onSessionStarted,
        onConfigOptionsUpdated: provider.onConfigOptionsUpdated,
        onAvailableCommands: provider.onAvailableCommands,
        onAuthRequired: provider.onAuthRequired,
        defaultModel: Effect.map(
          provider.snapshot.getSnapshot,
          (snapshot) => snapshot.models.find((model) => model.isDefault)?.slug,
        ),
        makeRuntime: (input) =>
          makeDevinAcpRuntime({
            ...input,
            devinSettings: effectiveConfig,
            environment: processEnv,
            childProcessSpawner: spawner,
            // User-initiated sessions may fall back to `devin-browser` when no
            // credentials exist at all; sessions with stored credentials skip
            // `authenticate` entirely.
            browserAuth: true,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
      });
      const textGeneration = yield* makeDevinTextGeneration(effectiveConfig, processEnv);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        snapshotForCwd: provider.snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to create Devin instance: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    ),
};
