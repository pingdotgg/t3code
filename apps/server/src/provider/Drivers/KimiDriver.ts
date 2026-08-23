import * as NodeOS from "node:os";

import { KimiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeKimiTurnActivity, type KimiTurnActivity } from "../acp/KimiAcpSupport.ts";
import { makeKimiAdapter } from "../Layers/KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  enrichKimiSnapshot,
  isTransientKimiProbeClassification,
  probeKimiProviderStatus,
  type KimiModelDiscoveryCache,
  type KimiProviderProbeResult,
} from "../Layers/KimiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
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
const decodeKimiSettings = Schema.decodeSync(KimiSettings);

export const resolveKimiDriverBinaryPath = Effect.fn("resolveKimiDriverBinaryPath")(function* (
  config: Pick<KimiSettings, "binaryPath">,
  options?: { readonly homeDirectory?: string },
) {
  const configuredBinaryPath = config.binaryPath.trim();
  if (configuredBinaryPath && configuredBinaryPath !== "kimi") {
    return configuredBinaryPath;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const officialBinaryPath = path.join(
    options?.homeDirectory ?? NodeOS.homedir(),
    ".kimi-code",
    "bin",
    platform === "win32" ? "kimi.exe" : "kimi",
  );
  const officialBinaryExists = yield* fileSystem
    .exists(officialBinaryPath)
    .pipe(Effect.orElseSucceed(() => false));
  return officialBinaryExists ? officialBinaryPath : configuredBinaryPath || "kimi";
});

export function runKimiProbeWithActiveTurnDeferral<A, E, R>(input: {
  readonly turnActivity: KimiTurnActivity;
  readonly probe: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    while (!(yield* input.turnActivity.beginProbeIfIdle)) {
      const activeCount = yield* input.turnActivity.activeCount;
      yield* Effect.logDebug("Deferring Kimi provider probe until active turns settle.", {
        activeTurnCount: activeCount,
      });
      yield* input.turnActivity.awaitIdle;
    }
    return yield* input.probe.pipe(Effect.ensuring(input.turnActivity.endProbe));
  });
}

const DRIVER_KIND = ProviderDriverKind.make("kimi");
// The Kimi CLI installs via Moonshot's install script (or a global npm
// package the script manages itself), so no T3-managed update path applies;
// updates stay manual.
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type KimiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

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

export const stabilizeKimiProviderProbe = Effect.fn("stabilizeKimiProviderProbe")(function* (
  lastKnownGoodRef: Ref.Ref<ServerProvider | null>,
  result: KimiProviderProbeResult<ServerProvider>,
) {
  if (result.classification._tag === "healthy") {
    yield* Ref.set(lastKnownGoodRef, result.snapshot);
    return result.snapshot;
  }
  if (isTransientKimiProbeClassification(result.classification)) {
    return (yield* Ref.get(lastKnownGoodRef)) ?? result.snapshot;
  }
  yield* Ref.set(lastKnownGoodRef, null);
  return result.snapshot;
});

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kimi",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
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
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const resolvedBinaryPath = yield* resolveKimiDriverBinaryPath(config);
      const effectiveConfig = {
        ...config,
        binaryPath: resolvedBinaryPath,
        enabled,
      } satisfies KimiSettings;
      const turnActivity = yield* makeKimiTurnActivity;
      const lastKnownGoodRef = yield* Ref.make<ServerProvider | null>(null);
      const discoveryCacheRef = yield* Ref.make<KimiModelDiscoveryCache | undefined>(undefined);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeKimiAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        turnActivity,
      });
      const textGeneration = yield* makeKimiTextGeneration(effectiveConfig, processEnv);

      const probeProvider = Effect.gen(function* () {
        const discoveryCache = yield* Ref.get(discoveryCacheRef);
        const result = yield* probeKimiProviderStatus(
          effectiveConfig,
          processEnv,
          discoveryCache ? { discoveryCache } : {},
        );
        if (result.classification._tag === "healthy") {
          yield* Ref.set(discoveryCacheRef, result.discoveryCache);
        } else if (!isTransientKimiProbeClassification(result.classification)) {
          yield* Ref.set(discoveryCacheRef, undefined);
        }
        return yield* stabilizeKimiProviderProbe(lastKnownGoodRef, {
          ...result,
          snapshot: stampIdentity(result.snapshot),
        });
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const checkProvider = runKimiProbeWithActiveTurnDeferral({
        turnActivity,
        probe: probeProvider,
      });

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const managedSnapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<KimiSettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKimiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichKimiSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
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
              detail: "Failed to build the Kimi provider snapshot.",
              cause,
            }),
        ),
      );
      const snapshot = {
        maintenanceCapabilities: managedSnapshot.maintenanceCapabilities,
        getSnapshot: managedSnapshot.getSnapshot,
        refresh: Ref.set(discoveryCacheRef, undefined).pipe(
          Effect.andThen(managedSnapshot.refresh),
        ),
        get streamChanges() {
          return managedSnapshot.streamChanges;
        },
      };

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
