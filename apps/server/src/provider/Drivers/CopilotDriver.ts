/**
 * CopilotDriver - ProviderDriver wrapper for the GitHub Copilot ACP runtime.
 *
 * The Copilot implementation pre-dates the provider-instance registry. This
 * driver adapts the existing snapshot and adapter factories into the current
 * per-instance shape so Copilot participates in settings, provider lists, and
 * routing like the other built-in drivers.
 *
 * @module provider/Drivers/CopilotDriver
 */
import { CopilotSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeCopilotTextGeneration } from "../../git/Layers/CopilotTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCopilotAdapter } from "../Layers/CopilotAdapter.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatusForSettings,
} from "../Layers/CopilotProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const NATIVE_DRIVER_KIND = ProviderDriverKind.make("copilot-acp-native");
const SNAPSHOT_REFRESH_INTERVAL = Duration.hours(1);

export type CopilotDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly driverKind: ProviderDriverKind;
  }) =>
  (snapshot: ServerProvider): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: input.driverKind,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const makeCopilotDriver = (input: {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
}): ProviderDriver<CopilotSettings, CopilotDriverEnv> => ({
  driverKind: input.driverKind,
  metadata: {
    displayName: input.displayName,
    supportsMultipleInstances: false,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => Schema.decodeSync(CopilotSettings)({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: input.driverKind,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        driverKind: input.driverKind,
      });
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;

      const adapter = yield* makeCopilotAdapter(
        eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : undefined,
      );
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig);

      const checkProvider = checkCopilotProviderStatusForSettings({
        settings: effectiveConfig,
        cwd: serverConfig.cwd,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<CopilotSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialCopilotProviderSnapshot(settings)),
        checkProvider,
        startInitialRefresh: false,
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
        driverKind: input.driverKind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
});

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = makeCopilotDriver({
  driverKind: DRIVER_KIND,
  displayName: "GitHub Copilot",
});

export const CopilotAcpNativeDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> =
  makeCopilotDriver({
    driverKind: NATIVE_DRIVER_KIND,
    displayName: "GitHub Copilot ACP Native (Experimental)",
  });
