import { ProviderDriverKind, type ServerProvider, TextGenerationError } from "@t3tools/contracts";
import { ZCodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { createZCodeAdapterV2, type ZCodeAdapterV2DriverEnv } from "./adapter.ts";
import { makeZCodeLiveState } from "./liveState.ts";
import {
  applyZCodeLiveState,
  buildInitialZCodeProviderSnapshot,
  checkZCodeProviderStatus,
  enrichZCodeSnapshot,
} from "./status.ts";

const decodeZCodeSettings = Schema.decodeSync(ZCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("zcode");
// The bridge is a separately installed npm package; T3 cannot tell which
// installer owns it, so updates stay manual.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "zcode-acp-server",
});

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ZCode instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export type ZCodeDriverEnv =
  | ZCodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | HttpClient.HttpClient;

export const ZCodeDriver: ProviderDriver<ZCodeSettings, ZCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    supportsMultipleInstances: true,
  },
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettings => decodeZCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const host = yield* ProviderHost.ProviderHost;
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
      const effectiveConfig = { ...config, enabled } satisfies ZCodeSettings;
      // Models and commands come from live sessions: listing them needs a
      // session, and status checks must not open one.
      const liveState = yield* makeZCodeLiveState;
      const orchestrationAdapter = yield* createZCodeAdapterV2({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
        liveState,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build ZCode orchestration adapter.",
              cause,
            }),
        ),
      );

      const checkProvider = checkZCodeProviderStatus(
        effectiveConfig,
        processEnv,
        host.paths.cwd,
      ).pipe(
        Effect.map((draft) => ({ ...stampIdentity(draft), supportsTextGeneration: false })),
        Effect.flatMap((provider) =>
          liveState.get.pipe(
            Effect.map((state) =>
              applyZCodeLiveState(provider, state, effectiveConfig.customModels),
            ),
          ),
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const liveSnapshotSemaphore = yield* Semaphore.make(1);
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, host.settings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ZCodeSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialZCodeProviderSnapshot(settings.provider).pipe(
            Effect.map((draft) => ({ ...stampIdentity(draft), supportsTextGeneration: false })),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, getSnapshot, publishSnapshot }) => {
          const publishAdvisory = enrichZCodeSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities: MAINTENANCE,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          });
          if (!currentSnapshot.installed) return publishAdvisory;
          // Republish whenever a live session advertises new models or commands.
          const followLiveState = liveState.changes.pipe(
            Stream.runForEach((state) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current: ServerProvider) =>
                    publishSnapshot(
                      applyZCodeLiveState(current, state, effectiveConfig.customModels),
                    ),
                  ),
                ),
              ),
            ),
          );
          return Effect.all([publishAdvisory, followLiveState], {
            concurrency: "unbounded",
            discard: true,
          });
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build ZCode snapshot.",
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
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
