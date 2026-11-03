import { CodexSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeCodexCliAuth } from "../CodexCliAuth.ts";
import type { CodexEffectiveRuntime } from "../CodexManagedRuntime.ts";
import { HttpClient } from "effect/http";
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
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { codexContinuationIdentity, materializeCodexShadowHome } from "./CodexHomeLayout.ts";
import { resolveCodexRuntime } from "./CodexRuntime.ts";
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

// Standalone updates use the executable's owning home, which can differ from the auth home.
function makeCodexMaintenanceResolver(
  sharedHomePath: string,
  managedDirectory: string,
): ProviderMaintenanceCapabilitiesResolver {
  const resolver = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
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
  return {
    resolve: Effect.fn("CodexDriver.resolveMaintenance")(function* (context) {
      if (context) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realManaged = yield* fs
          .realPath(managedDirectory)
          .pipe(Effect.orElseSucceed(() => managedDirectory));
        // T3 owns this versioned package; Codex's self-updater only handles its own installs.
        if (context.realCommandPath.startsWith(`${realManaged}${path.sep}`)) {
          return { provider: DRIVER_KIND, packageName: null, update: null };
        }
      }
      return yield* resolver.resolve(context);
    }),
  };
}

export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Digest.Digest
  | SecureRandom.SecureRandom
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
    const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const cliAccount = config.setupMode === "cli";
    const binaryPath =
      expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory) || "codex";
    const runtime = yield* resolveCodexRuntime({
      instanceId,
      config,
      environment: instanceEnvironment,
      stateDir: (yield* ServerConfig.ServerConfig).stateDir,
    });
    const { homeLayout, environment: processEnv } = runtime;
    const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
    const runtimePaths = {
      homePath: homeLayout.sharedHomePath,
      shadowHomePath: accountKey,
    };
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
      ...runtime.config,
      enabled,
      binaryPath,
    } satisfies CodexSettings;
    const resolveRuntime = Effect.gen(function* () {
      const resolvedBinaryPath =
        enabled && (cliAccount || binaryPath === "codex")
          ? yield* resolveCommandPath(binaryPath, { env: processEnv })
          : undefined;
      const executablePath =
        enabled && binaryPath === "codex" && !resolvedBinaryPath
          ? yield* installation.acquire({ managedOnly: true }).pipe(
              Effect.map((executable) => executable.executablePath),
              Effect.catchTags({ CodexInstallationError: () => Effect.succeed(binaryPath) }),
            )
          : cliAccount
            ? (resolvedBinaryPath ?? binaryPath)
            : binaryPath;
      return {
        config: { ...effectiveConfig, binaryPath: executablePath },
        environment: processEnv,
        revision: executablePath,
      } satisfies CodexEffectiveRuntime;
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
    const auth = cliAccount
      ? yield* makeCodexCliAuth({ instanceId, homePath: accountKey, resolveRuntime })
      : undefined;
    const withAccess = <A, E, R>(task: Effect.Effect<A, E, R>) =>
      auth?.withAccess ? auth.withAccess(task) : task;
    const stampSnapshot = (draft: Parameters<typeof stampIdentity>[0]) =>
      stampIdentity({
        ...draft,
        ...(cliAccount
          ? {
              setup: {
                ...draft.setup,
                canAuthenticate: true,
                canInstall: binaryPath === "codex",
              },
              ...(draft.auth.status === "unauthenticated"
                ? { message: "Sign in with Codex CLI in provider settings." }
                : {}),
              runtimePaths: {
                ...draft.runtimePaths,
                ...runtimePaths,
              },
            }
          : {}),
      });
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveRuntime.pipe(
        Effect.flatMap((runtime) =>
          resolveProviderMaintenanceCapabilitiesEffect(
            makeCodexMaintenanceResolver(homeLayout.sharedHomePath, installation.managedDirectory),
            {
              binaryPath: runtime.config.binaryPath,
              env: runtime.environment,
            },
          ),
        ),
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
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
        compatibility: installation.compatibility,
        resolveRuntime,
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
          withAccess(
            resolveRuntime.pipe(
              Effect.flatMap((runtime) =>
                checkCodexProviderStatus(runtime.config, undefined, runtime.environment).pipe(
                  Effect.map((draft) =>
                    cliAccount && pathService.isAbsolute(runtime.config.binaryPath)
                      ? {
                          ...draft,
                          runtimePaths: {
                            ...runtimePaths,
                            binaryPath: runtime.config.binaryPath,
                          },
                        }
                      : draft,
                  ),
                ),
              ),
            ),
          ).pipe(
            Effect.scoped,
            Effect.catchTags({
              ProviderSetupError: () => makePendingCodexProvider(effectiveConfig),
            }),
          ),
          currentCatalog,
          (draft, catalog) => stampSnapshot(applyCodexModelCatalog(draft, catalog)),
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
          (draft, catalog) => stampSnapshot(applyCodexModelCatalog(draft, catalog)),
        ),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.tap(() =>
            settings.enableProviderUpdateChecks
              ? installation.refresh().pipe(Effect.ignore)
              : Effect.void,
          ),
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
    if (auth) {
      yield* auth.subscribe("codex-cli-snapshot").pipe(
        Stream.filter(
          (state) =>
            ["succeeded", "failed", "cancelled"].includes(state.phase) ||
            (state.phase === "idle" && state.message !== null),
        ),
        Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause)),
        Effect.forkScoped,
      );
    }
    const nativeGeneration = yield* makeCodexTextGeneration(
      effectiveConfig,
      processEnv,
      snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
      resolveRuntime,
    );
    const protect = <A>(operation: string, task: Effect.Effect<A, TextGenerationError>) =>
      withAccess(task).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: cause.detail,
            }),
        ),
      );
    const textGeneration: ProviderInstance["textGeneration"] = auth
      ? {
          supportedOperations: nativeGeneration.supportedOperations,
          generateCommitMessage: (input) =>
            protect("generateCommitMessage", nativeGeneration.generateCommitMessage(input)),
          generatePrContent: (input) =>
            protect("generatePrContent", nativeGeneration.generatePrContent(input)),
          generateBranchName: (input) =>
            protect("generateBranchName", nativeGeneration.generateBranchName(input)),
          generateThreadTitle: (input) =>
            protect("generateThreadTitle", nativeGeneration.generateThreadTitle(input)),
          generateReviewGuide: (input) =>
            protect("generateReviewGuide", nativeGeneration.generateReviewGuide(input)),
          generateKnowledgeCandidates: (input) =>
            protect(
              "generateKnowledgeCandidates",
              nativeGeneration.generateKnowledgeCandidates(input),
            ),
          generateConversationSummary: (input) =>
            protect(
              "generateConversationSummary",
              nativeGeneration.generateConversationSummary(input),
            ),
        }
      : nativeGeneration;
    const snapshotForCwd = (cwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            withAccess(
              resolveRuntime.pipe(
                Effect.flatMap((runtime) =>
                  probeCodexSkillsForCwd({
                    binaryPath: runtime.config.binaryPath,
                    homePath: runtime.config.homePath,
                    launchArgs: resolveCodexLaunchArgs(
                      runtime.config.launchArgs,
                      runtime.environment,
                    ),
                    cwd,
                    environment: runtime.environment,
                    ...(cliAccount ? { extendEnv: false } : {}),
                  }),
                ),
              ),
            ).pipe(
              Effect.scoped,
              Effect.timeout("20 seconds"),
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

    // Redemption spends credit: serialize by auth.json directory, preserve the idempotency key,
    // and bound the wait. Auth overlays have their own account; continuation keys conflate them.
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
      resetCreditCoordinator
        .redeem(accountKey, (idempotencyKey) =>
          withAccess(
            Effect.gen(function* () {
              const runtime = yield* resolveRuntime;
              const { client } = yield* withCodexAppServerClient({
                binaryPath: runtime.config.binaryPath,
                homePath: runtime.config.homePath,
                launchArgs: resolveCodexLaunchArgs(runtime.config.launchArgs, runtime.environment),
                cwd: process.cwd(),
                environment: runtime.environment,
                ...(cliAccount ? { extendEnv: false } : {}),
              });
              const response = yield* client.request("account/rateLimitResetCredit/consume", {
                idempotencyKey,
              });
              return response.outcome;
            }),
          ).pipe(Effect.scoped, Effect.timeout("20 seconds")),
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
          // The windows just changed; re-probe so the snapshot says so. A
          // failed probe republishes the pre-redemption limits rather than
          // marking them failed, so "confirmed" means `checkedAt` moved past
          // what was published before the redemption started.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
              const refreshed = yield* snapshot.refresh;
              const after = refreshed.usageLimits?.checkedAt;
              if (
                outcome === "reset" &&
                (after === undefined ||
                  after === before ||
                  refreshed.usageLimits?.unavailable?.reason === "probeFailed")
              ) {
                return yield* new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail:
                    "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                });
              }
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
      snapshot: {
        ...snapshot,
        refresh: enabled
          ? installation
              .refresh({ fresh: true })
              .pipe(Effect.ignore, Effect.andThen(snapshot.refresh))
          : snapshot.refresh,
      },
      snapshotForCwd,
      consumeResetCredit,
      orchestrationAdapter,
      textGeneration,
      ...(auth ? { auth } : {}),
    } satisfies ProviderInstance;
  }),
};
