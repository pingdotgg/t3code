import { ProviderDriverKind } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeMuseTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeMuseAdapterV2 } from "./adapter.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkMuseProviderStatus, makePendingMuseProvider } from "./status.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { enrichMuseSnapshot, latestMuseVersion, museMaintenance } from "./maintenance.ts";
import { makeMuseEnvironment } from "./sdk.ts";
import type { MuseSubscriptionUsage } from "./protocol.ts";
import { museUsageAccount, museUsageWindows, type MuseUsageAccount } from "./usageLimits.ts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { museUsageReader } from "./usage.ts";
import { refreshMuseUsage } from "./usageProbe.ts";
import type * as MuseUsageHome from "./MuseUsageHome.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";

const DRIVER_KIND = ProviderDriverKind.make("muse");
const decodeMuseSettings = Schema.decodeSync(MuseSettings);

export type MuseDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const MuseDriver: ProviderDriver<
  MuseSettings,
  MuseDriverEnv,
  Path.Path | MuseUsageHome.MuseUsageHome
> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  usage: museUsageReader,
  configSchema: MuseSettings,
  defaultConfig: () => decodeMuseSettings({}),
  create: Effect.fn("MuseDriver.create")(function* ({
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
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const { cwd } = host.paths;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const hostEnvironment = yield* HostProcess.Environment;
    // Drop an inherited META_API_KEY so Muse uses its login; an instance value still wins.
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      makeMuseEnvironment(hostEnvironment),
    );
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies MuseSettings;
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
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    // Keep CLI observations and streamed reports in the same account generation.
    const usageAccount = yield* Ref.make<MuseUsageAccount>({
      generation: 0,
      identity: undefined,
    });
    const latestUsage = yield* Ref.make<
      { readonly usage: MuseSubscriptionUsage; readonly generation: number } | undefined
    >(undefined);
    // Serialize state changes and publication; CLI reads run outside this permit
    // so slow refreshes cannot block the adapter's notification stream.
    const usagePermit = yield* Semaphore.make(1);
    const withUsageLimits = Effect.fn("MuseDriver.withUsageLimits")(function* (
      provider: ServerProviderDraft,
    ) {
      const refreshed = yield* refreshMuseUsage({
        settings: effectiveConfig,
        environment: processEnvironment,
        cwd,
        provider,
        state: { account: usageAccount, latestUsage, permit: usagePermit },
      });
      return refreshed.provider;
    });
    const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnvironment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const resolveMaintenance = Effect.fn("MuseDriver.resolveMaintenance")(function* (options?: {
      readonly fresh?: boolean;
    }) {
      const capabilities = yield* resolveInstallation(options);
      // The maintenance runner requests fresh capabilities around an explicit update
      // and needs the native target version to verify that the command actually upgraded.
      const latestVersion = options?.fresh
        ? yield* latestMuseVersion(processEnvironment, { fresh: true }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          )
        : undefined;
      return latestVersion !== undefined ? { ...capabilities, latestVersion } : capabilities;
    });
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
      // Status refresh respects update checks; explicit updates use the resolver below.
      resolveMaintenance: (options) =>
        host.settings.get.pipe(
          Effect.orDie,
          Effect.flatMap((settings) =>
            settings.enableProviderUpdateChecks
              ? resolveMaintenance(options)
              : resolveInstallation(options),
          ),
        ),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        makePendingMuseProvider(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkMuseProviderStatus(effectiveConfig, processEnvironment, cwd).pipe(
        Effect.flatMap(withUsageLimits),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichMuseSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              environment: processEnvironment,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap(publishSnapshot),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Muse Code snapshot.",
            cause,
          }),
      ),
    );
    const modelCatalog = snapshot.getSnapshot.pipe(Effect.map((current) => current.models));
    const orchestrationAdapter = yield* makeMuseAdapterV2({
      instanceId,
      settings: effectiveConfig,
      environment: processEnvironment,
      modelCatalog,
      usageAccountGeneration: Ref.get(usageAccount).pipe(
        Effect.map((account) => account.generation),
      ),
      // Per-notification work stays within the adapter's notification handling.
      onSubscriptionUsage: Effect.fnUntraced(function* (
        usage: MuseSubscriptionUsage,
        hostGeneration: number,
      ) {
        const account = yield* Ref.get(usageAccount);
        // A host from before a logout or another login reports for an account
        // that is gone, and signed out there is no account to report for.
        if (hostGeneration !== account.generation || account.identity === null) return;
        // Every session's host reports; an older report arriving late must not win.
        const newer = yield* Ref.modify(latestUsage, (previous) =>
          previous && previous.usage.observedAtMs >= usage.observedAtMs
            ? [false, previous]
            : [true, { usage, generation: hostGeneration }],
        );
        const { auth } = yield* snapshot.getSnapshot;
        // The probe may have advanced the generation before publishing its new account.
        if (!newer || auth.type === "apiKey" || museUsageAccount(auth) !== account.identity) return;
        const now = yield* DateTime.now;
        yield* snapshot.applyUsageLimits({
          windows: museUsageWindows(usage, DateTime.toEpochMillis(now)),
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
          // A report is the account's whole state, so a window that has reset
          // since loses its old reset time instead of keeping it.
          replace: true,
        });
      }, usagePermit.withPermits(1)),
      ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      continuationRequests,
    });
    const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, {
      environment: processEnvironment,
      modelCatalog,
    });
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: { ...snapshot, resolveMaintenance },
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
