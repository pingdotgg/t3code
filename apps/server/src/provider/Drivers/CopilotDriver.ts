/**
 * CopilotDriver — `ProviderDriver` for the GitHub Copilot SDK runtime.
 *
 * Mirrors the other provider drivers: a plain value whose `create()` returns
 * one `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `CopilotSettings`.
 *
 * Each instance owns an isolated Copilot home directory under server state and
 * a per-instance SDK client, so sessions and persisted cursors do not leak
 * across configured Copilot providers.
 *
 * @module provider/Drivers/CopilotDriver
 */
import { CopilotSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";

import { makeCopilotTextGeneration } from "../../textGeneration/CopilotTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCopilotAdapter } from "../Layers/CopilotAdapter.ts";
import {
  checkCopilotProviderStatus,
  makePendingCopilotProvider,
} from "../Layers/CopilotProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const SNAPSHOT_REFRESH_INTERVAL = Duration.hours(1);
const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

export type CopilotDriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | Context.Service.Identifier<typeof HostProcessPlatform>
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;
      const baseDirectory = path.join(serverConfig.stateDir, "providers", "copilot", instanceId);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: "@github/copilot-sdk",
      });
      yield* fileSystem.makeDirectory(baseDirectory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to prepare Copilot home: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeCopilotAdapter(effectiveConfig, {
        instanceId,
        baseDirectory,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv, {
        baseDirectory,
      });

      const snapshot = yield* makeManagedServerProvider<CopilotSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          Effect.succeed(stampIdentity(makePendingCopilotProvider(settings))),
        checkProvider: checkCopilotProviderStatus({
          settings: effectiveConfig,
          cwd: serverConfig.cwd,
          baseDirectory,
          environment: processEnv,
        }).pipe(Effect.map(stampIdentity)),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Copilot snapshot: ${cause.message ?? String(cause)}`,
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
