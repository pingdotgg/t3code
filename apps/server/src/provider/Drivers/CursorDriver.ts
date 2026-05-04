/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent (`agent`) runtime.
 *
 * Cursor exposes an ACP-based CLI. The driver is still a plain value, but
 * its snapshot uses `makeManagedServerProvider`'s optional `enrichSnapshot`
 * hook to run the slow ACP model-capability probe in the background without
 * blocking the initial `ready`-state publish.
 *
 * Text generation is supported via the ACP runtime — `makeCursorTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/CursorDriver
 */
import { CursorSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeCursorTextGeneration } from "../../textGeneration/CursorTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  enrichCursorSnapshot,
} from "../Layers/CursorProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type CursorDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly iconUrl: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CursorDriver: ProviderDriver<CursorSettings, CursorDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => Schema.decodeSync(CursorSettings)({}),
  create: ({ instanceId, displayName, accentColor, iconUrl, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
        displayName,
        accentColor,
        iconUrl,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CursorSettings;

      const adapter = yield* makeCursorAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeCursorTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkCursorProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<CursorSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialCursorProviderSnapshot(settings)),
        checkProvider,
        // Preserve the background ACP model-capability probe that used to
        // live on `CursorProviderLive`. Only fires when the snapshot reports
        // an authenticated, enabled provider with at least one non-custom
        // model whose capabilities haven't been captured yet.
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichCursorSnapshot({
            settings,
            environment: processEnv,
            snapshot: currentSnapshot,
            publishSnapshot,
            stampIdentity,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Cursor snapshot: ${cause.message ?? String(cause)}`,
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
        iconUrl,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
