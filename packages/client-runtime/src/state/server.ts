import {
  type EnvironmentId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  shouldRecommendDatabaseCompaction,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { request, requestGuarded, runStream, type EnvironmentRpcInput } from "../rpc/client.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";

export type { ServerConfigProjection } from "./serverConfigProjection.ts";

import {
  EMPTY_SERVER_UPDATE_STATE_ATOM,
  serverUpdateStateAtom,
  serverUpdateStateForServerVersion,
} from "./serverUpdate.ts";
import { serverConfigStateChanges } from "./serverConfigState.ts";
import { createServerUpdateCommand } from "./serverUpdate.ts";
import { resolveServerConfigValue, serverWelcomeStateChanges } from "./serverWelcomeState.ts";
import {
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
  type FetchedWorkspaceSnapshot,
} from "./serverWorkspaceSnapshots.ts";

export * from "./serverUpdate.ts";
export * from "./serverConfigState.ts";
export * from "./serverWelcomeState.ts";
export * from "./serverWorkspaceSnapshots.ts";
export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
    readonly environmentThemes?: boolean;
    readonly usageLimitSources?: boolean;
    readonly usageLimitsCommand?: boolean;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const updateScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        serverConfigStateChanges(environmentId, {
          ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
          ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
          ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
        }),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const fetchedWorkspaceSnapshotsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<FetchedWorkspaceSnapshot>>([]).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:server:fetched-workspace-snapshots:${environmentId}`),
    ),
  );
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    let previousProviders: ServerConfig["providers"] | undefined;
    return Atom.make((get): ServerConfig | null => {
      const projection = AsyncResult.getOrElse(
        get(configProjection({ environmentId, input: {} })),
        () => null,
      );
      const config = resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
      if (config === null) return null;
      const merged = withFetchedWorkspaceSnapshots(
        config,
        get(fetchedWorkspaceSnapshotsAtom(environmentId)),
      );
      if (merged === config) return config;
      // Keep provider identities stable across config events; the projection already reuses the rest.
      previousProviders = reuseUnchanged(previousProviders, merged.providers);
      return { ...merged, providers: previousProviders };
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const updateStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      serverUpdateStateForServerVersion(
        get(serverUpdateStateAtom(environmentId)),
        get(configValueAtom(environmentId))?.environment.serverVersion ?? null,
      ),
    ).pipe(Atom.withLabel(`environment-data:server:update-state-value:${environmentId}`)),
  );
  const updateStateAtom = (environmentId: EnvironmentId | null) =>
    environmentId === null ? EMPTY_SERVER_UPDATE_STATE_ATOM : updateStateValueAtom(environmentId);
  const updateServer = createServerUpdateCommand<R, E>({
    runtime,
    scheduler: updateScheduler,
    configScheduler,
    concurrency: configConcurrency,
    configValueAtom,
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const hiddenThreadTagsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const settings = get(settingsValueAtom(environmentId));
      if (settings?.hideTaggedThreads !== true) return null;
      // Tags are trimmed on write; trim hand-edited entries so " private" still matches.
      const tags = settings.hiddenThreadTags.map((tag) => tag.trim()).filter((tag) => tag !== "");
      return tags.length > 0 ? tags : null;
    }).pipe(
      // Trimming makes a new array on every settings push; keep equal lists stable.
      Atom.withEquality(
        (a: ReadonlyArray<string> | null, b: ReadonlyArray<string> | null) =>
          a === b ||
          (a !== null &&
            b !== null &&
            a.length === b.length &&
            a.every((tag, index) => tag === b[index])),
      ),
      Atom.withLabel(`environment-data:server:hidden-thread-tags:${environmentId}`),
    ),
  );
  const usagePricesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const overrides = get(settingsValueAtom(environmentId))?.usagePriceOverrides ?? {};
      // Only changed prices should trigger another transcript scan. Settings
      // snapshots can recreate the same mapping in a different property order.
      return JSON.stringify(
        Object.keys(overrides)
          .sort()
          .map((model) => {
            const price = overrides[model]!;
            return [
              model,
              price.inputCostPerMillionTokens,
              price.outputCostPerMillionTokens,
              price.cacheReadCostPerMillionTokens,
              price.cacheWriteCostPerMillionTokens,
            ];
          }),
      );
    }).pipe(Atom.withLabel(`environment-data:server:usage-prices:${environmentId}`)),
  );
  const usageScanSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const settings = get(settingsValueAtom(environmentId));
      const aliases = settings?.usageModelAliases ?? {};
      return JSON.stringify([
        get(usagePricesAtom(environmentId)),
        Object.keys(aliases)
          .sort()
          .map((model) => [model, aliases[model]]),
        settings?.cursorKeychainUsageEnabled ?? false,
      ]);
    }).pipe(Atom.withLabel(`environment-data:server:usage-scan-settings:${environmentId}`)),
  );
  // Settings snapshots rebuild the filter object; only a changed filter should touch the Usage tab.
  const usageModelFilterAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(settingsValueAtom(environmentId))?.usageModelFilter).pipe(
      Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      Atom.withLabel(`environment-data:server:usage-model-filter:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );
  const welcomeStateFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverWelcomeStateChanges(environmentId), { initialValue: null })
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:welcome-state:${environmentId}`),
      ),
  );
  const welcomeFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(welcomeStateFamily(environmentId));
      if (result._tag !== "Success") return result;
      return result.value === null
        ? AsyncResult.initial<ServerLifecycleWelcomePayload, never>(result.waiting)
        : AsyncResult.success(result.value, result);
    }).pipe(Atom.withLabel(`environment-data:server:welcome:${environmentId}`)),
  );
  const databaseStorage = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:database-storage",
    tag: WS_METHODS.serverGetDatabaseStorage,
    idleTtlMs: 0,
  });
  // Keyed by a JSON array of environment ids so one notice can list every machine.
  const databaseCompactionRecommendations = Atom.family((environmentIdsKey: string) => {
    const sources = (JSON.parse(environmentIdsKey) as EnvironmentId[]).map((environmentId) => ({
      environmentId,
      atom: databaseStorage({ environmentId, input: {} }),
    }));
    return Atom.make((get) =>
      sources
        .flatMap(({ environmentId, atom }) => {
          const result = get(atom);
          return result._tag === "Success" &&
            result.value !== null &&
            shouldRecommendDatabaseCompaction(result.value)
            ? [{ environmentId, status: result.value }]
            : [];
        })
        .sort((left, right) => right.status.reclaimableBytes - left.status.reclaimableBytes),
    ).pipe(
      Atom.withLabel(
        `environment-data:server:database-compaction-recommendations:${environmentIdsKey}`,
      ),
    );
  });
  const welcome = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerLifecycle>;
  }) => welcomeFamily(target.environmentId);
  const updateSettings = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:update-settings",
    tag: WS_METHODS.serverUpdateSettings,
    scheduler: configScheduler,
    concurrency: configConcurrency,
  });

  return {
    configValueAtom,
    runStorageCleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:run-storage-cleanup",
      tag: WS_METHODS.serverRunStorageCleanup,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    prepareTriage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:prepare-triage",
      tag: WS_METHODS.serverPrepareTriage,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    databaseStorage,
    databaseCompactionRecommendations,
    storageCleanupReport: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:storage-cleanup-report",
      tag: WS_METHODS.serverGetStorageCleanupReport,
      idleTtlMs: 0,
    }),
    updateStateAtom,
    settingsValueAtom,
    hiddenThreadTagsAtom,
    usageModelFilterAtom,
    providersValueAtom,
    providerAuthState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:auth-state",
      tag: WS_METHODS.providerAuthSubscribe,
      idleTtlMs: 0,
    }),
    startProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-start",
      tag: WS_METHODS.providerAuthStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    respondProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-respond",
      tag: WS_METHODS.providerAuthRespond,
    }),
    completeProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-complete",
      tag: WS_METHODS.providerAuthComplete,
    }),
    chatGptReconnectProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:reconnect-profile",
      tag: WS_METHODS.chatGptReconnectProfile,
    }),
    chatGptImportProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:import-profile",
      tag: WS_METHODS.chatGptImportProfile,
    }),
    chatGptHandoffState: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:chatgpt:handoff",
      sensitiveInput: true,
      // OAuth must not be replayed when the connection recovers.
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.chatGptHandoffSubscribe>) =>
        runStream(WS_METHODS.chatGptHandoffSubscribe, input),
      idleTtlMs: 0,
    }),
    cancelProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-cancel",
      tag: WS_METHODS.providerAuthCancel,
    }),
    logoutProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-logout",
      tag: WS_METHODS.providerAuthLogout,
    }),
    providerInstallState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:install-state",
      tag: WS_METHODS.providerInstallSubscribe,
      idleTtlMs: 0,
    }),
    startProviderInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-start",
      tag: WS_METHODS.providerInstallStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    cancelProviderInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-cancel",
      tag: WS_METHODS.providerInstallCancel,
    }),
    removeProviderInstallation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-remove",
      tag: WS_METHODS.providerInstallRemove,
    }),
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    npmRelease: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:npm-release",
      tag: WS_METHODS.serverGetNpmRelease,
      staleTimeMs: 60_000,
      refreshIntervalMs: 5 * 60_000,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    hostResources: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:server:host-resources",
      idleTtlMs: 0,
      staleTimeMs: 5_000,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.serverGetHostResources>) =>
        request(WS_METHODS.serverGetHostResources, input).pipe(Effect.timeout("5 seconds")),
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    scheduledTaskWebhookDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-deliveries",
      tag: WS_METHODS.scheduledTasksListWebhookDeliveries,
    }),
    scheduledTaskWebhookDelivery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-delivery",
      tag: WS_METHODS.scheduledTasksGetWebhookDelivery,
    }),
    scheduledTasksLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:scheduled-tasks:live",
      tag: WS_METHODS.scheduledTasksSubscribe,
    }),
    // A cold transcript scan is measured in seconds, so keep the result around
    // long enough that switching windows or re-rendering does not rescan.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:usage-summary",
      tag: WS_METHODS.serverGetUsageSummary,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => usageScanSettingsAtom(environmentId),
      execute: (input, emit) =>
        request(WS_METHODS.serverGetUsageSummary, input).pipe(
          Effect.filterOrElse(
            (summary) => !summary.sources.some((source) => source.refreshing === true),
            (summary) =>
              emit(summary).pipe(
                Effect.andThen(
                  request(WS_METHODS.serverGetUsageSummary, { ...input, awaitRefresh: true }),
                ),
                Effect.catch((error) =>
                  Effect.logWarning("Could not refresh slow usage sources.").pipe(
                    Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
                    Effect.as(summary),
                  ),
                ),
              ),
          ),
        ),
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
    }),
    searchAcpRegistry: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:acp-registry:search",
      tag: WS_METHODS.serverSearchAcpRegistry,
      // Reopening Add provider reuses recent results. Submitting the same search asks the
      // server again, which reuses a Registry index fetched in the last five minutes.
      staleTimeMs: 5 * 60_000,
    }),
    configProjection,
    welcome,
    legacyThreadMigration: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:legacy-thread-migration",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "legacyThreadMigration"
              ? Result.succeed(event.payload)
              : Result.failVoid,
          ),
        ),
    }),
    consumeResetCredit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:consume-reset-credit",
      tag: WS_METHODS.providerConsumeResetCredit,
      concurrency: {
        mode: "singleFlight",
        // Both ids are free-form strings; a delimiter could collide.
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      execute: (input) =>
        requestGuarded(WS_METHODS.serverRefreshProviders, {
          ...input,
          workspaceSnapshotsOnDemand: true,
          ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
        }),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          const { instanceId, cwd } = input;
          if (instanceId === undefined || cwd === undefined) return;
          registry.update(fetchedWorkspaceSnapshotsAtom(environmentId), (current) =>
            recordFetchedWorkspaceSnapshot(
              current,
              { instanceId, cwd, fresh: input.fresh === true },
              result.providers,
              registry
                .get(configValueAtom(environmentId))
                ?.providers.find((provider) => provider.instanceId === instanceId),
            ),
          );
        }),
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.instanceId ?? null,
            input.cwd ?? null,
            input.fresh ?? false,
            input.refreshModels ?? false,
          ]),
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateServer,
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings,
    mutateProviderInstance: updateSettings,
    prepareAcpRegistryAgent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:prepare",
      tag: WS_METHODS.serverPrepareAcpRegistryAgent,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.agentId}`,
      },
    }),
    uninstallAcpRegistryManagedBinary: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:uninstall-managed-binary",
      tag: WS_METHODS.serverUninstallAcpRegistryManagedBinary,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.agentId}`,
      },
    }),
    acceptAcpRegistryUrlAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:accept-url-auth",
      tag: WS_METHODS.serverAcceptAcpRegistryUrlAuth,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.elicitationId}`,
      },
    }),
    listAcpRegistrySessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-sessions",
      tag: WS_METHODS.serverListAcpRegistrySessions,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.cursor ?? "first"}`,
      },
    }),
    importAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:import-session",
      tag: WS_METHODS.serverImportAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    deleteAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:delete-session",
      tag: WS_METHODS.serverDeleteAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    listAcpRegistryProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-providers",
      tag: WS_METHODS.serverListAcpRegistryProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}`,
      },
    }),
    setAcpRegistryProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:set-provider",
      tag: WS_METHODS.serverSetAcpRegistryProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.providerId}`,
      },
    }),
    disableAcpRegistryProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:disable-provider",
      tag: WS_METHODS.serverDisableAcpRegistryProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.providerId}`,
      },
    }),
    logoutAcpRegistry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:logout",
      tag: WS_METHODS.serverLogoutAcpRegistry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
      },
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    upsertScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:upsert",
      tag: WS_METHODS.scheduledTasksUpsert,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setScheduledTaskEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:set-enabled",
      tag: WS_METHODS.scheduledTasksSetEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    deleteScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:delete",
      tag: WS_METHODS.scheduledTasksDelete,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Deliberately not on the config lane: run-now blocks until the run is
    // dispatched, and a slow run must not stall settings/keybinding/provider
    // mutations (or other scheduled-task edits) queued behind it.
    runScheduledTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:run-now",
      tag: WS_METHODS.scheduledTasksRunNow,
    }),
    rotateScheduledTaskWebhookToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:rotate-webhook-token",
      tag: WS_METHODS.scheduledTasksRotateWebhookToken,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    createGuestShare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:guest-share:create",
      tag: WS_METHODS.guestShareCreate,
    }),
    // Off the config lane: answering a card must not queue behind settings
    // edits. One answer per card at a time.
    answerSecretRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:secrets:answer-request",
      tag: WS_METHODS.secretsAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
    refreshUsageRates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-usage-rates",
      tag: WS_METHODS.serverRefreshUsageRates,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    checkOtlpEndpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:check-otlp-endpoint",
      tag: WS_METHODS.serverCheckOtlpEndpoint,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
