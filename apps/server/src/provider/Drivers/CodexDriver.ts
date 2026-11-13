import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Signature from "effect/crypto/Signature";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import type * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { makeManagedCodexProvider } from "./CodexManagedProvider.ts";
import { codexUsageReader } from "./codexUsage.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
const CODEX_STANDALONE_HOME_PATTERN = /^(.*)\/packages\/standalone\//is;

function codexStandaloneHome(commandPath: string): string | null {
  // Slash replacement preserves indices; Unicode lowercasing can change the path length.
  const match = CODEX_STANDALONE_HOME_PATTERN.exec(commandPath.replaceAll("\\", "/"));
  if (!match) {
    return null;
  }
  const home = match[1]!;
  // Keep root separators: `C:` is drive-relative, and an empty home is not `/`.
  const isRoot = home === "" || /^[a-z]:$/i.test(home);
  return commandPath.slice(0, home.length + (isRoot ? 1 : 0));
}

// Standalone updates locate their install through CODEX_HOME. Account and auth-overlay
// homes can share an executable, so only the updater uses the executable's owning home.
function makeCodexMaintenanceResolver(sharedHomePath: string) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    mise: { tool: "codex" },
    nativeUpdate: {
      args: ["update"],
      isCommandPath: (commandPath) => codexStandaloneHome(commandPath) !== null,
      requiresCommandPath: true,
      env: (context) => ({
        CODEX_HOME:
          codexStandaloneHome(context.realCommandPath) ??
          codexStandaloneHome(context.resolvedCommandPath) ??
          sharedHomePath,
      }),
    },
  });
}

// `codex update` installs this channel's release, which can lag npm's latest tag.
const CODEX_NATIVE_CHANNEL = "https://releases.openai.com/codex/channels/latest";
const CodexNativeRelease = Schema.Struct({ tag_name: Schema.String });

function withCodexNativeLatestVersion(
  capabilities: ProviderMaintenanceCapabilities,
  http: HttpClient.HttpClient,
): ProviderMaintenanceCapabilities {
  if (capabilities.update?.lockKey !== `${DRIVER_KIND}-native`) return capabilities;
  return {
    ...capabilities,
    latestVersion: null,
    latestVersionCacheKey: CODEX_NATIVE_CHANNEL,
    lookupLatestVersion: http.get(CODEX_NATIVE_CHANNEL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(CodexNativeRelease)),
      Effect.map((release) => /^rust-v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1] ?? null),
      Effect.timeoutOption("4 seconds"),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    ),
  };
}

export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Digest.Digest
  | SecureRandom.SecureRandom
  | Signature.Signature
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | CodexInstallation.CodexInstallation
  | CodexManagedTokenBroker.CodexManagedTokenBroker;

export const CodexDriver: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: Effect.fn("CodexDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    if (config.setupMode === "managed")
      return yield* makeManagedCodexProvider({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const installation = yield* CodexInstallation.CodexInstallation;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER_KIND);
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const environmentHome = processEnv.CODEX_HOME;
    const homeLayout = yield* resolveCodexHomeLayout(
      !config.homePath.trim() && !config.shadowHomePath.trim() && environmentHome?.trim()
        ? { ...config, homePath: environmentHome }
        : config,
    );
    const continuationIdentity = codexContinuationIdentity(homeLayout);
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;
    const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(
        makeCodexMaintenanceResolver(homeLayout.sharedHomePath),
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );
    const resolveMaintenance: typeof resolveInstallation = (options) =>
      resolveInstallation(options).pipe(
        Effect.map((capabilities) => withCodexNativeLatestVersion(capabilities, httpClient)),
      );

    const orchestrationAdapter = yield* createCodexAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      },
      {
        onUsageLimits: (update) => snapshot.applyUsageLimits(update),
        models: Effect.suspend(() => snapshot.getSnapshot).pipe(
          Effect.map((value) => value.models),
        ),
        compatibility: installation.compatibility,
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Codex orchestration adapter.",
            cause,
          }),
      ),
    );

    // Kick the TTL-gated manifest refresh in the background and classify with the in-memory
    // manifest, so a slow or hung fetch never delays the provider check.
    const checkProvider = modelCatalog.refreshInBackground.pipe(
      Effect.andThen(
        Effect.zipWith(
          checkCodexProviderStatus(effectiveConfig, undefined, processEnv),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
          { concurrent: true },
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        Effect.zipWith(
          makePendingCodexProvider(settings.provider),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
        ),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCodexTextGeneration(
      effectiveConfig,
      processEnv,
      snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    );
    const snapshotForCwd = (cwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            probeCodexSkillsForCwd({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              cwd,
              environment: processEnv,
            }).pipe(
              Effect.scoped,
              Effect.timeout(resolveProviderProbeTimeoutMs("codex", 20_000, processEnv)),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ]).pipe(
            Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: `Failed to probe Codex skills for '${cwd}'`,
                  cause,
                }),
            ),
          );

    // Redemption spends account credit; serialize by the auth.json directory, keep one idempotency key
    // until the outcome, and bound the wait so a hung app-server cannot hold the account lock.
    // Auth overlays use effectiveHomePath; the continuation key would conflate them with shared homes.
    const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
      resetCreditCoordinator
        .redeem(accountKey, (idempotencyKey) =>
          Effect.gen(function* () {
            const { client } = yield* withCodexAppServerClient({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              cwd: process.cwd(),
              environment: processEnv,
            });
            const response = yield* client.request("account/rateLimitResetCredit/consume", {
              idempotencyKey,
            });
            return response.outcome;
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        )
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Codex could not redeem the reset credit.",
                cause,
              }),
          ),
          Effect.tap((outcome) =>
            ResetCreditCoordinator.refreshAfterRedemption({
              outcome,
              getSnapshot: snapshot.getSnapshot,
              refresh: snapshot.refresh,
            }).pipe(
              Effect.filterOrFail(
                (confirmed) => confirmed,
                () =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail:
                      "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                  }),
              ),
            ),
          ),
        );

    // `codex login` and `codex logout` rewrite auth.json outside T3.
    if (effectiveConfig.enabled) {
      yield* fileSystem.watch(accountKey).pipe(
        Stream.filter((event) => pathService.basename(event.path) === "auth.json"),
        Stream.debounce(Duration.millis(250)),
        Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
        Effect.ignoreCause({ log: true }),
        Effect.forkScoped,
      );
    }
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      consumeResetCredit,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
