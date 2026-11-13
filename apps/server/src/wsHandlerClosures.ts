import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  AcpRegistryOperationError,
  CommandId,
  authScopeResponse,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type ScheduledTaskListResult,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  type DiscoveredLocalServerList,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationV2Command,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type MessageId,
  type AcpRegistryImportSessionInput,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDisableProviderInput,
  type AcpRegistryListProvidersInput,
  type AcpRegistryListSessionsInput,
  type AcpRegistrySetProviderInput,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationV2SearchThreadError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  CLIENT_CAPABILITIES_QUERY_PARAM,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadStreamItem,
  type ApplicationStoredEvent,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerConfig as ClientServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ChatAttachmentId,
  PersistChatAttachmentsError,
  RpcClientId,
  EnvironmentAuthorizationError,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  bufferShellLiveStream,
  coalesceShellApplicationEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  loadOlderSettledThreadsPage,
  loadShellSnapshotParts,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  loadSubscriberShellSnapshot,
  shellStreamItemsFromResumeSnapshot,
  shouldPublishShellApplicationEvent,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "./orchestration-v2/ShellStream.ts";
import * as ServerSettings from "./serverSettings.ts";
import { mutateProjectWithClone } from "./project/ProjectMutation.ts";
import { requiredScopeForDeviceList, rpcAuthorizationError } from "./auth/RpcAuthorization.ts";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import type { WsHandlerServices } from "./wsHandlerServices.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { withoutWorkspaceSnapshots } from "./wsClientContext.ts";
import { resolveOpenDiscoveryForConfig } from "./wsConfigDiscovery.ts";
import { enrichProjectShells } from "./wsOrchestrationSubscriptions.ts";

// Extracted from ./ws.ts: the closures layerWsRpc's RPC handlers close over.
export interface WsHandlerClosuresParams {
  currentSession: EnvironmentAuth.AuthenticatedSession;
  serverBrowser: ServerBrowser.ServerBrowser["Service"];
  reportProfiles: ServerBrowser.ProfileReporter;
  settingsClient: { readonly secretReferences: boolean };
  state: WsHandlerServices;
}

export const makeWsHandlerClosures = Effect.fn("ws.makeHandlerClosures")(function* (
  params: WsHandlerClosuresParams,
) {
  const { currentSession, serverBrowser, reportProfiles, settingsClient } = params;
  const { currentSessionId, sql, threadManagement, applicationEvents, projectStore, projectService, managedFolders, eventLoopMonitor, threadLaunch, providerSessionManager, random, usageLimitSources, projectCloneTracker, keybindings, externalLauncher, remoteOpenTargets, directEndpoints, vcsStatusBroadcaster, providerRegistry, providerInstances, acpRegistryRuntimeCoordinator, config, serverSettings, startup, serverEnvironment, serverAuth, sessions } = params.state;

  const withVisibleWebhookUrls = (result: ScheduledTaskListResult): ScheduledTaskListResult =>
    currentSession.scopes.includes(AuthOrchestrationOperateScope)
      ? result
      : {
          tasks: result.tasks.map(({ webhook: _webhook, ...task }) => task),
        };
  const authorizeEffect = <A, E, R>(
    requiredScope: AuthEnvironmentScope,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
    currentSession.scopes.includes(requiredScope)
      ? effect
      : Effect.fail(rpcAuthorizationError(requiredScope));

  const acpRegistryProject = Effect.fn("ws.acpRegistry.project")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectService.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} is unavailable.`,
            cause,
          }),
      ),
    );
    return yield* Effect.fromOption(
      project,
      () =>
        new AcpRegistryOperationError({
          reason: "project_not_found",
          message: `Project ${projectId} was not found.`,
        }),
    );
  });

  const acpSessionManager = Effect.fn("ws.acpRegistry.sessionManager")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "instance_not_found",
        message: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance.acpSessionManagement === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: `Provider instance ${instanceId} does not expose ACP session management.`,
      });
    }
    return { instance, manager: instance.acpSessionManagement };
  });

  const importedAcpThreadId = (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly sessionId: string;
  }) =>
    IdAllocator.deriveThreadFromProviderThread({
      driver: input.driver,
      providerInstanceId: input.instanceId,
      nativeThreadId: input.sessionId,
    });

  const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
    input: AcpRegistryListSessionsInput,
  ) {
    const project = yield* acpRegistryProject(input.projectId);
    const { instance, manager } = yield* acpSessionManager(input.instanceId);
    const listed = yield* manager.listSessions({
      cwd: project.workspaceRoot,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const sessions = yield* Effect.forEach(
      listed.sessions,
      (session) => {
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: session.sessionId,
        });
        return threadManagement.getThreadShell(threadId).pipe(
          Effect.map((thread) => ({
            ...session,
            importedThreadId: thread === null ? null : threadId,
          })),
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not inspect existing imported ACP sessions.",
                cause,
              }),
          ),
        );
      },
      { concurrency: 16 },
    );
    return { ...listed, sessions };
  });

  const importAcpRegistrySession = Effect.fn("ws.acpRegistry.importSession")(function* (
    input: AcpRegistryImportSessionInput,
  ) {
    return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
      Effect.gen(function* () {
        yield* acpRegistryProject(input.projectId);
        const { instance } = yield* acpSessionManager(input.instanceId);
        const providerSnapshot = yield* instance.snapshot.getSnapshot;
        if (
          providerSnapshot.nativeSessions?.canLoad !== true &&
          providerSnapshot.nativeSessions?.canResume !== true
        ) {
          return yield* new AcpRegistryOperationError({
            reason: "session_resume_unsupported",
            message: "The ACP agent cannot load or resume native sessions.",
          });
        }
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: input.sessionId,
        });
        const existing = yield* threadManagement.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not inspect the imported ACP session mapping.",
                cause,
              }),
          ),
        );
        if (existing !== null) return { threadId, imported: false } as const;

        const provider = (yield* providerRegistry.getProviders).find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        const model =
          provider?.models.find((candidate) => candidate.isDefault)?.slug ??
          provider?.models[0]?.slug ??
          "default";
        const commandId = CommandId.make(yield* random.uuidV4());
        const launched = yield* Effect.result(
          startup.enqueueCommand(
            threadLaunch.launch({
              commandId,
              threadId,
              projectId: input.projectId,
              title: input.title ?? "Imported ACP session",
              modelSelection: { instanceId: input.instanceId, model },
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              importedNativeThread: {
                ref: {
                  driver: instance.driverKind,
                  nativeId: input.sessionId,
                  strength: "strong",
                },
                metadata: {
                  itemIdentityVersion: 2,
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
                },
              },
              createdBy: "user",
              creationSource: "web",
            }),
          ),
        );
        if (Result.isFailure(launched)) {
          const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new AcpRegistryOperationError({
                  reason: "session_import_failed",
                  message: "Could not inspect the imported ACP session after launch failed.",
                  cause,
                }),
            ),
          );
          if (racedImport !== null) return { threadId, imported: false } as const;
          return yield* new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not create a T3 thread for the ACP session.",
            cause: launched.failure,
          });
        }
        return { threadId, imported: true } as const;
      }),
    );
  });

  const deleteAcpRegistrySession = Effect.fn("ws.acpRegistry.deleteSession")(function* (
    input: AcpRegistryDeleteSessionInput,
  ) {
    return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
      Effect.gen(function* () {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.nativeSessions?.canDelete !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "session_delete_unsupported",
            message: "The ACP agent does not advertise session deletion.",
          });
        }
        const threadId = importedAcpThreadId({
          driver: instance.driverKind,
          instanceId: input.instanceId,
          sessionId: input.sessionId,
        });
        const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "session_delete_failed",
                message: "Could not inspect the imported ACP session mapping.",
                cause,
              }),
          ),
        );
        if (importedThread !== null) {
          return yield* new AcpRegistryOperationError({
            reason: "session_delete_failed",
            message: "Delete the imported T3 thread before deleting its native ACP session.",
          });
        }
        yield* manager.deleteSession({
          cwd: project.workspaceRoot,
          sessionId: input.sessionId,
        });
        return { deleted: true } as const;
      }),
    );
  });

  const listAcpRegistryProviders = Effect.fn("ws.acpRegistry.listProviders")(function* (
    input: AcpRegistryListProvidersInput,
  ) {
    const project = yield* acpRegistryProject(input.projectId);
    const { instance, manager } = yield* acpSessionManager(input.instanceId);
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.configurableProviders !== true) {
      return yield* new AcpRegistryOperationError({
        reason: "providers_unsupported",
        message: "The ACP agent does not advertise provider configuration.",
      });
    }
    return yield* manager.listProviders(project.workspaceRoot);
  });

  const setAcpRegistryProvider = Effect.fn("ws.acpRegistry.setProvider")(function* (
    input: AcpRegistrySetProviderInput,
  ) {
    const project = yield* acpRegistryProject(input.projectId);
    const { manager } = yield* acpSessionManager(input.instanceId);
    if (input.headers !== undefined && Object.keys(input.headers).length > 32) {
      return yield* new AcpRegistryOperationError({
        reason: "provider_configuration_failed",
        message: "ACP provider configuration accepts at most 32 headers.",
      });
    }
    const listed = yield* manager.listProviders(project.workspaceRoot);
    const provider = listed.providers.find(
      (candidate) => candidate.providerId === input.providerId,
    );
    if (provider === undefined || !provider.supported.includes(input.apiType)) {
      return yield* new AcpRegistryOperationError({
        reason: "provider_configuration_failed",
        message: `Provider ${input.providerId} does not support ${input.apiType}.`,
      });
    }
    yield* providerSessionManager.closeInstance(input.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "Could not stop live sessions before updating the ACP provider.",
            cause,
          }),
      ),
    );
    yield* manager.setProvider({
      cwd: project.workspaceRoot,
      providerId: input.providerId,
      apiType: input.apiType,
      baseUrl: input.baseUrl,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    });
    yield* providerRegistry.refreshInstance(input.instanceId);
    return { configured: true } as const;
  });

  const disableAcpRegistryProvider = Effect.fn("ws.acpRegistry.disableProvider")(function* (
    input: AcpRegistryDisableProviderInput,
  ) {
    const project = yield* acpRegistryProject(input.projectId);
    const { manager } = yield* acpSessionManager(input.instanceId);
    const listed = yield* manager.listProviders(project.workspaceRoot);
    const provider = listed.providers.find(
      (candidate) => candidate.providerId === input.providerId,
    );
    if (provider === undefined || provider.required) {
      return yield* new AcpRegistryOperationError({
        reason: "provider_configuration_failed",
        message:
          provider === undefined
            ? `Provider ${input.providerId} was not advertised by the ACP agent.`
            : `Provider ${input.providerId} is required and cannot be disabled.`,
      });
    }
    yield* providerSessionManager.closeInstance(input.instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "Could not stop live sessions before disabling the ACP provider.",
            cause,
          }),
      ),
    );
    yield* manager.disableProvider({
      cwd: project.workspaceRoot,
      providerId: input.providerId,
    });
    yield* providerRegistry.refreshInstance(input.instanceId);
    return { disabled: true } as const;
  });
  const loadAuthAccessSnapshot = () =>
    Effect.all({
      pairingLinks: serverAuth.listPairingLinks(),
      clientSessions: serverAuth.listClientSessions(currentSessionId),
    }).pipe(
      Effect.mapError(
        (error) =>
          new AuthAccessStreamError({
            message: error.message,
          }),
      ),
    );

  const loadServerConfig = Effect.fn("ws.loadServerConfig")(function* (options: {
    readonly usageLimitsCommand: boolean;
    readonly workspaceSnapshotsOnDemand: boolean;
    readonly deferNetworkDiscovery: boolean;
  }) {
    const keybindingsConfig = yield* keybindings.loadConfigState;
    const currentProviders = yield* providerRegistry.getProviders;
    const commandProviders = options.usageLimitsCommand
      ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
      : currentProviders;
    const providers = options.workspaceSnapshotsOnDemand
      ? withoutWorkspaceSnapshots(commandProviders)
      : commandProviders;
    const settings = ServerSettings.redactServerSettingsForClient(
      yield* serverSettings.getSettings,
      settingsClient,
    );
    const environment = yield* serverEnvironment.getDescriptor;
    const auth = yield* serverAuth.getDescriptor();
    const scratchWorkspaceRoot = yield* managedFolders.scratchRoot;
    const lastEventLoopStall = yield* eventLoopMonitor.latestNoticeableStall;
    const discovery = yield* resolveOpenDiscoveryForConfig({
      editors: externalLauncher.resolveAvailableEditors(),
      fileManagerRevealKind: externalLauncher.resolveFileManagerRevealKind(),
      remoteOpenTargets: options.deferNetworkDiscovery
        ? Effect.succeed([])
        : remoteOpenTargets.resolveTargets(),
      directEndpoints: options.deferNetworkDiscovery
        ? directEndpoints.resolveAvailable()
        : directEndpoints.resolve(),
    });

    return {
      environment,
      auth,
      cwd: config.cwd,
      keybindingsConfigPath: config.keybindingsConfigPath,
      keybindings: keybindingsConfig.keybindings,
      issues: keybindingsConfig.issues,
      providers,
      ...discovery,
      observability: {
        logsDirectoryPath: config.logsDir,
        localTracingEnabled: true,
        ...(config.otlpTracesUrl !== undefined
          ? {
              otlpTracesUrl: config.otlpTracesUrl,
              otlpTracesSource: config.otlpTracesSource,
              otlpTracesVariable: config.otlpTracesVariable,
            }
          : {}),
        otlpTracesEnabled: config.otlpTracesUrl !== undefined,
        ...(config.otlpMetricsUrl !== undefined
          ? {
              otlpMetricsUrl: config.otlpMetricsUrl,
              otlpMetricsSource: config.otlpMetricsSource,
              otlpMetricsVariable: config.otlpMetricsVariable,
            }
          : {}),
        otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
        ...(config.otlpLogsUrl !== undefined
          ? {
              otlpLogsUrl: config.otlpLogsUrl,
              otlpLogsSource: config.otlpLogsSource,
              otlpLogsVariable: config.otlpLogsVariable,
            }
          : {}),
        otlpLogsEnabled: config.otlpLogsUrl !== undefined,
      },
      settings,
      ...(serverSettings.managedPolicy === undefined
        ? {}
        : { managedPolicy: serverSettings.managedPolicy }),
      shellResumeCompletionMarker: true,
      shellThreadFamilies: true,
      shellOlderSettled: true,
      threadResumeCompletionMarker: true,
      threadSnapshotPagination: true,
      threadFind: true,
      threadFindProgressive: true,
      secretProviderSettings: true,
      secretReferences: true,
      ...Option.match(scratchWorkspaceRoot, {
        onNone: () => ({}),
        onSome: (root) => ({ scratchWorkspaceRoot: root }),
      }),
      newProjectsRoot: managedFolders.namedProjectsRoot,
      ...(lastEventLoopStall === undefined ? {} : { lastEventLoopStall }),
    };
  });

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const getOrchestrationV2ArchivedShellSnapshot = Effect.gen(function* () {
    const { threads, projects, snapshotSequence } = yield* loadShellSnapshotParts({
      sql,
      readThreads: threadManagement.readShellSnapshot({ location: "archive" }),
      listProjects: projectStore.listShells(),
      latestSequence: applicationEvents.latestApplicationSequence,
    });
    return {
      schemaVersion: threads.schemaVersion,
      snapshotSequence,
      projects,
      threads: threads.archivedThreads,
    } as const;
  }).pipe(
    Effect.flatMap((snapshot) =>
      enrichProjectShells(snapshot.projects).pipe(
        Effect.map(({ projects }) => ({ ...snapshot, projects })),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new OrchestrationV2GetShellSnapshotError({
          message: "Failed to load archived thread snapshot",
          cause,
        }),
    ),
  );

  // Rows the shell can omit, read with the same snapshot sequence the shell uses.
  const readOmittableShellRows = Effect.fn("ws.orchestrationV2.readOmittableShellRows")(
    function* (
      options: { readonly familyOf: ThreadId } | { readonly worktreePath: string },
      message: string,
    ) {
      const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
        sql,
        readThreads: threadManagement.readShellSnapshot({ location: "active", ...options }),
        listProjects: Effect.succeed([]),
        latestSequence: applicationEvents.latestApplicationSequence,
      }).pipe(
        Effect.mapError(
          (cause) => new OrchestrationV2GetShellSnapshotError({ message, cause }),
        ),
      );
      return { snapshotSequence, threads: threads.threads };
    },
  );

  const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
    return yield* mutateProjectWithClone(projectService, projectCloneTracker, mutation);
  });


  return {
    currentSession,
    serverBrowser,
    reportProfiles,
    settingsClient,
    withVisibleWebhookUrls,
    authorizeEffect,
    acpRegistryProject,
    acpSessionManager,
    importedAcpThreadId,
    listAcpRegistrySessions,
    importAcpRegistrySession,
    deleteAcpRegistrySession,
    listAcpRegistryProviders,
    setAcpRegistryProvider,
    disableAcpRegistryProvider,
    loadAuthAccessSnapshot,
    loadServerConfig,
    refreshGitStatus,
    getOrchestrationV2ArchivedShellSnapshot,
    readOmittableShellRows,
    mutateProject,
  };
});

export type WsHandlerClosures = Effect.Success<ReturnType<typeof makeWsHandlerClosures>>;
