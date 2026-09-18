/**
 * OpenCode2Driver — `ProviderDriver` for the OpenCode 2 background service.
 *
 * Mirrors the OpenCodeDriver's bundle shape (snapshot / adapter /
 * textGeneration closures over the per-instance `OpenCode2Settings`), but
 * there is no process to own: the adapter and probe connect to the machine's
 * background service (or the configured `serverUrl`). Maintenance is
 * manual-only — the v2 binary manages its own updates.
 *
 * @module provider/Drivers/OpenCode2Driver
 */
import { OpenCode2Settings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeOpenCode2TextGeneration } from "../../textGeneration/OpenCode2TextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCode2Adapter } from "../Layers/OpenCode2Adapter.ts";
import {
  checkOpenCode2ProviderStatus,
  makePendingOpenCode2Provider,
} from "../Layers/OpenCode2Provider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as OpenCode2Runtime from "../opencode2Runtime.ts";
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

const decodeOpenCode2Settings = Schema.decodeSync(OpenCode2Settings);

const DRIVER_KIND = ProviderDriverKind.make("opencode2");

// The v2 binary ships its own updater; T3 never manages it.
const MANUAL_ONLY = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type OpenCode2DriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | OpenCode2Runtime.OpenCode2Runtime
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const OpenCode2Driver: ProviderDriver<OpenCode2Settings, OpenCode2DriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode 2",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCode2Settings,
  defaultConfig: (): OpenCode2Settings => decodeOpenCode2Settings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const openCode2Runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
      const serverSettings = yield* ServerSettingsService;
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
      const effectiveConfig = { ...config, enabled } satisfies OpenCode2Settings;

      const adapter = yield* makeOpenCode2Adapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });

      const textGeneration = yield* makeOpenCode2TextGeneration(effectiveConfig);

      const checkProviderForCwd = (cwd: string) =>
        checkOpenCode2ProviderStatus(effectiveConfig, cwd).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(OpenCode2Runtime.OpenCode2Runtime, openCode2Runtime),
        );
      const checkProvider = checkProviderForCwd(serverConfig.cwd);

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OpenCode2Settings>
      >({
        resolveMaintenance: () => Effect.succeed(MANUAL_ONLY),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        checkProviderOnSettingsChange: () => true,
        refreshOnInterval: false,
        initialSnapshot: (settings) =>
          makePendingOpenCode2Provider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode 2 snapshot: ${cause.message ?? String(cause)}`,
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
        snapshotForCwd: (cwd) =>
          checkProviderForCwd(cwd).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: `Failed to probe OpenCode 2 for '${cwd}'`,
                  cause,
                }),
            ),
          ),
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
