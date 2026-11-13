import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
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
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import {
  makeLiveBodyDeduper,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { invalidateSettingsSecrets } from "./sourceControl/sourceControlHostSecrets.ts";
import { readWorkflowScript } from "./orchestration-v2/workflowScriptQuery.ts";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import { MAX_CLIENT_APP_VERSION_LENGTH, MAX_CLIENT_BROWSER_LENGTH, MAX_CLIENT_DEVICE_MODEL_LENGTH, PROVIDER_STATUS_DEBOUNCE_MS, filesystemBrowseFailureContext, hasCompatibleOrchestrationProtocol, isClientConnectionMethod, isClientDeviceType, isClientOs, isClientSurface, isClientWebDeployment, persistChatAttachments, projectEntriesFailureContext, projectFileFailureContext, readSettingsClient, toAuthAccessStreamEvent, withoutWorkspaceSnapshots } from "./wsClientContext.ts";
import { enrichProjectShells, subscribeOrchestrationV2Shell, subscribeOrchestrationV2Thread } from "./wsOrchestrationSubscriptions.ts";
import type { AllWsHandlers, WsHandlerContext } from "./wsHandlerTypes.ts";

// Extracted from ./ws.ts: RPC handlers for core.
export type WsRpcHandlersCore = Pick<
  AllWsHandlers,
  typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand | typeof ORCHESTRATION_V2_WS_METHODS.stopWorkflow | typeof ORCHESTRATION_V2_WS_METHODS.forceStopThread | typeof ORCHESTRATION_V2_WS_METHODS.getWorkflowScript | typeof ORCHESTRATION_V2_WS_METHODS.getNativeChildWork | typeof ORCHESTRATION_V2_WS_METHODS.getTurnItem | typeof ORCHESTRATION_V2_WS_METHODS.getTurnDiff | typeof ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff | typeof ORCHESTRATION_V2_WS_METHODS.searchThread | typeof ORCHESTRATION_V2_WS_METHODS.searchThreadStream | typeof ORCHESTRATION_V2_WS_METHODS.searchThreads | typeof ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot | typeof ORCHESTRATION_V2_WS_METHODS.getThreadFamily | typeof ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads | typeof ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds | typeof ORCHESTRATION_V2_WS_METHODS.getThreadProjection | typeof ORCHESTRATION_V2_WS_METHODS.launchThread | typeof ORCHESTRATION_V2_WS_METHODS.subscribeShell | typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread | typeof ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput | typeof WS_METHODS.scheduledTasksSubscribe | typeof WS_METHODS.scheduledTasksUpsert | typeof WS_METHODS.scheduledTasksSetEnabled | typeof WS_METHODS.scheduledTasksDelete | typeof WS_METHODS.scheduledTasksRunNow | typeof WS_METHODS.scheduledTasksRotateWebhookToken | typeof WS_METHODS.guestShareCreate | typeof WS_METHODS.secretsAnswerRequest | typeof WS_METHODS.scheduledTasksListWebhookDeliveries | typeof WS_METHODS.scheduledTasksGetWebhookDelivery | typeof WS_METHODS.serverProbe | typeof WS_METHODS.serverGetConfig | typeof WS_METHODS.serverSearchAcpRegistry | typeof WS_METHODS.serverPrepareAcpRegistryAgent | typeof WS_METHODS.serverUninstallAcpRegistryManagedBinary | typeof WS_METHODS.serverAcceptAcpRegistryUrlAuth | typeof WS_METHODS.serverListAcpRegistrySessions | typeof WS_METHODS.serverImportAcpRegistrySession | typeof WS_METHODS.serverDeleteAcpRegistrySession | typeof WS_METHODS.serverListAcpRegistryProviders | typeof WS_METHODS.serverSetAcpRegistryProvider | typeof WS_METHODS.serverDisableAcpRegistryProvider | typeof WS_METHODS.serverLogoutAcpRegistry | typeof WS_METHODS.serverRefreshProviders
>;

export const wsRpcHandlersCore = (ctx: WsHandlerContext) => {
  const { sql, threadManagement, intakeContext, applicationEvents, threadSearch, analytics, originProps, recordClientCommandAnalytics, threadLaunch, commandOutputHub, providerSessionManager, scheduledTasks, secretRequests, guestShares, usageLimitSources, checkpointDiffQuery, nativeChildWork, providerRegistry, providerInstances, acpRegistryCatalog, acpRegistryRuntimeCoordinator, providerAuth, config, serverSettings, secretResolver, startup, sessions, withVisibleWebhookUrls, acpSessionManager, listAcpRegistrySessions, importAcpRegistrySession, deleteAcpRegistrySession, listAcpRegistryProviders, setAcpRegistryProvider, disableAcpRegistryProvider, loadServerConfig, getOrchestrationV2ArchivedShellSnapshot, readOmittableShellRows } = ctx;

  return ({
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": command.commandId,
        "orchestration_v2.command_type": command.type,
        "orchestration_v2.thread_id":
          command.type === "thread.fork" || command.type === "thread.merge_back"
            ? command.targetThreadId
            : command.type === "delegated_task.request" ||
                command.type === "delegated_task.wake-policy" ||
                command.type === "delegated_task.completion-delivery.acknowledge" ||
                command.type === "delegated_task.completion-delivery.dispose" ||
                command.type === "thread.created.record"
              ? command.parentThreadId
              : command.threadId,
        ...(command.type === "thread.fork" || command.type === "thread.merge_back"
          ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
          : {}),
      }).pipe(
        Effect.andThen(
          startup
            .enqueueCommand(
              (command.type === "prepared-run.retry"
                ? threadLaunch.retryPreparation(command)
                : ThreadMessageIntake.dispatchCommand(
                    ThreadManagementService.withCreationProvenance(command, {
                      createdBy: "user",
                      creationSource:
                        "creationSource" in command ? command.creationSource : "web",
                    }),
                  )
              ).pipe(Effect.provide(intakeContext)),
            )
            .pipe(
              Effect.tap((result) =>
                result.replayed ? Effect.void : recordClientCommandAnalytics(command),
              ),
              Effect.map((result) => ({ sequence: result.sequence })),
              Effect.mapError((cause) => {
                const detail = userFacingDispatchErrorMessage(cause);
                return new OrchestrationV2DispatchCommandError({
                  commandId: command.commandId,
                  commandType: command.type,
                  message: detail ?? "Failed to dispatch orchestration V2 command",
                  ...(detail === undefined ? {} : { detail }),
                  cause,
                });
              }),
            ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: (input) => threadManagement.stopWorkflow(input),
    [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: (input) =>
      threadManagement.forceStopThread(input),
    [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
      readWorkflowScript({ scriptPath: input.scriptPath }),
    [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: (input) =>
      nativeChildWork.getNativeChildWork(input),
    [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
      threadManagement.getTurnItem(input).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: "Failed to load turn item",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
      checkpointDiffQuery.getTurnDiff(input).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetTurnDiffError({
              message: "Failed to load turn diff",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
      checkpointDiffQuery.getFullThreadDiff(input).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetFullThreadDiffError({
              message: "Failed to load full thread diff",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.searchThread]: (input) =>
      threadManagement
        .searchThread(input)
        .pipe(Effect.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
    [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input) =>
      threadManagement
        .searchThreadStream(input)
        .pipe(Stream.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
    [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
      ThreadSearch.searchThreadsWithOlderSettledRows({
        request: input,
        search: threadSearch.search,
        searchOlderSettled: threadSearch.searchOlderSettled,
        sql,
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({ location: "active", threadIds }),
        latestSequence: applicationEvents.latestApplicationSequence,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationSearchThreadsError({
              message: "Failed to search threads",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
      getOrchestrationV2ArchivedShellSnapshot,
    [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: (input) =>
      readOmittableShellRows({ familyOf: input.threadId }, "Failed to load the thread family"),
    [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: (input) =>
      loadOlderSettledThreadsPage({
        sql,
        listThreads: threadManagement.listOlderSettledThreads(input),
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({ location: "active", threadIds }),
        latestSequence: applicationEvents.latestApplicationSequence,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load older settled threads",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: (input) =>
      readOmittableShellRows(
        { worktreePath: input.worktreePath },
        "Failed to load the worktree's threads",
      ).pipe(Effect.map(({ threads }) => ({ threadIds: threads.map((thread) => thread.id) }))),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(
          // Bound compatibility snapshots so pre-pagination clients cannot materialize unlimited transcripts.
          threadManagement
            .getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            })
            .pipe(
              Effect.map(
                (snapshot) =>
                  buildBoundedThreadProjection({
                    projection: projectThreadProjectionForWire(snapshot.projection),
                    snapshotSequence: snapshot.snapshotSequence,
                  }).projection,
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to load orchestration V2 thread ${input.threadId}`,
                    cause,
                  }),
              ),
            ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
      Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId,
        "orchestration_v2.project_id": input.projectId,
      }).pipe(
        Effect.andThen(
          startup
            .enqueueCommand(
              ThreadMessageIntake.launchThread({
                commandId: input.commandId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.reuseExistingThread === undefined
                  ? {}
                  : { reuseExistingThread: input.reuseExistingThread }),
                projectId: input.projectId,
                title: input.title,
                ...(input.generateTitle === undefined
                  ? {}
                  : { generateTitle: input.generateTitle }),
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                workspaceStrategy: input.workspaceStrategy,
                ...(input.initialMessage === undefined
                  ? {}
                  : {
                      initialMessage: {
                        ...(input.initialMessage.messageId === undefined
                          ? {}
                          : { messageId: input.initialMessage.messageId }),
                        text: input.initialMessage.text,
                        attachments: input.initialMessage.attachments,
                        ...(input.initialMessage.context === undefined
                          ? {}
                          : { context: input.initialMessage.context }),
                      },
                    }),
                createdBy: "user",
                creationSource: input.creationSource ?? "web",
              }).pipe(Effect.provide(intakeContext)),
            )
            .pipe(
              // A resumed launch is a retry of one already counted.
              Effect.tap((result) =>
                result.resumed
                  ? Effect.void
                  : analytics
                      .record("client.thread.started", {
                        ...originProps,
                        workspaceStrategy: input.workspaceStrategy.type,
                      })
                      .pipe(
                        Effect.andThen(
                          input.initialMessage === undefined
                            ? Effect.void
                            : analytics.record("client.turn.requested", originProps),
                        ),
                        Effect.ignore,
                      ),
              ),
              Effect.map((result) => ({
                ...result,
                projection: projectThreadProjectionForWire(result.projection),
              })),
              Effect.catchTags({
                AttachmentClaimError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                ThreadLaunchError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: "Failed to launch thread",
                    cause,
                  }),
                ServerRuntimeStartupError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: "Failed to launch thread",
                    cause,
                  }),
                ThreadManagementProviderInstanceDisabledError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
              }),
            ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      Stream.unwrap(subscribeOrchestrationV2Shell(input)),
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
      Stream.unwrap(
        Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
          Effect.andThen(subscribeOrchestrationV2Thread(input)),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
      Stream.unwrap(
        Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
          Effect.as(commandOutputHub.subscribe(input)),
        ),
      ),
    [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
      scheduledTasks.subscribeList().pipe(Stream.map(withVisibleWebhookUrls)),
    [WS_METHODS.scheduledTasksUpsert]: (input) => scheduledTasks.upsert(input),
    [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.setEnabled(input)),
      ),
    [WS_METHODS.scheduledTasksDelete]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.delete(input)),
      ),
    [WS_METHODS.scheduledTasksRunNow]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.runNow(input)),
      ),
    [WS_METHODS.scheduledTasksRotateWebhookToken]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.rotateWebhookToken(input)),
      ),
    [WS_METHODS.guestShareCreate]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(guestShares.create(input)),
      ),
    [WS_METHODS.secretsAnswerRequest]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(secretRequests.answer(input)),
      ),
    [WS_METHODS.scheduledTasksListWebhookDeliveries]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.listWebhookDeliveries(input)),
      ),
    [WS_METHODS.scheduledTasksGetWebhookDelivery]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.getWebhookDelivery(input)),
      ),
    [WS_METHODS.serverProbe]: (_input) => Effect.succeed({}),
    [WS_METHODS.serverGetConfig]: (_input) =>
      loadServerConfig({
        usageLimitsCommand: false,
        workspaceSnapshotsOnDemand: false,
        deferNetworkDiscovery: false,
      }),
    [WS_METHODS.serverSearchAcpRegistry]: (input) =>
      acpRegistryCatalog
        .search(input)
        .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
    [WS_METHODS.serverPrepareAcpRegistryAgent]: (input) =>
      Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
        Effect.andThen(
          acpRegistryCatalog
            .prepare(input)
            .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
        ),
      ),
    [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: (input) =>
      Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
        Effect.andThen(
          acpRegistryCatalog
            .uninstallManagedBinary(input)
            .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
        ),
      ),
    [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: (input) =>
      Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
        Effect.andThen(
          acpRegistryRuntimeCoordinator
            .acceptUrlAuthentication(input)
            .pipe(Effect.map((accepted) => ({ accepted }))),
        ),
      ),
    [WS_METHODS.serverListAcpRegistrySessions]: (input) =>
      Effect.annotateCurrentSpan({
        "provider.instance_id": input.instanceId,
        "project.id": input.projectId,
      }).pipe(Effect.andThen(listAcpRegistrySessions(input))),
    [WS_METHODS.serverImportAcpRegistrySession]: (input) =>
      Effect.annotateCurrentSpan({
        "provider.instance_id": input.instanceId,
        "project.id": input.projectId,
      }).pipe(Effect.andThen(importAcpRegistrySession(input))),
    [WS_METHODS.serverDeleteAcpRegistrySession]: (input) =>
      Effect.annotateCurrentSpan({
        "provider.instance_id": input.instanceId,
        "project.id": input.projectId,
      }).pipe(Effect.andThen(deleteAcpRegistrySession(input))),
    [WS_METHODS.serverListAcpRegistryProviders]: (input) =>
      Effect.annotateCurrentSpan({
        "provider.instance_id": input.instanceId,
        "project.id": input.projectId,
      }).pipe(Effect.andThen(listAcpRegistryProviders(input))),
    [WS_METHODS.serverSetAcpRegistryProvider]: (input) =>
      Effect.annotateCurrentSpan({
        "provider.instance_id": input.instanceId,
        "project.id": input.projectId,
      }).pipe(Effect.andThen(setAcpRegistryProvider(input))),
    [WS_METHODS.serverDisableAcpRegistryProvider]: (input) =>
      Effect.annotateCurrentSpan({
        "provider.instance_id": input.instanceId,
        "project.id": input.projectId,
      }).pipe(Effect.andThen(disableAcpRegistryProvider(input))),
    [WS_METHODS.serverLogoutAcpRegistry]: (input) =>
      Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const { instance, manager } = yield* acpSessionManager(input.instanceId);
            const snapshot = yield* instance.snapshot.getSnapshot;
            if (snapshot.auth.canLogout !== true) {
              return yield* new AcpRegistryOperationError({
                reason: "logout_unsupported",
                message: "The ACP agent does not advertise logout.",
              });
            }
            if (instance.auth) {
              yield* providerAuth.logout(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "logout_failed",
                      message: "Could not sign out of the ACP agent.",
                      cause,
                    }),
                ),
              );
            } else {
              yield* providerSessionManager.closeInstance(input.instanceId).pipe(
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "logout_failed",
                      message: "Could not stop live sessions before ACP logout.",
                      cause,
                    }),
                ),
              );
              yield* manager.logout(config.cwd);
            }
            yield* providerRegistry.refreshInstance(input.instanceId);
            return { loggedOut: true } as const;
          }),
        ),
      ),
    [WS_METHODS.serverRefreshProviders]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (input) {
        if (input.refreshModels) {
          yield* providerRegistry.invalidateModelCaches({
            instanceId: input.instanceId,
            cwd: input.cwd,
            fresh: input.fresh,
          });
        }
        if (input.reloadSecrets === true && input.instanceId === undefined) {
          yield* invalidateSettingsSecrets(secretResolver, serverSettings.getSettings);
        }
        // Await refresh; RPC scope closure would interrupt a fork before the hub answered.
        if (input.instanceId === undefined) {
          yield* usageLimitSources.refresh;
        }
        let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
          ? providerRegistry.refreshWorkspaceSnapshot({
              instanceId: input.instanceId,
              cwd: input.cwd,
              fresh: input.fresh === true,
            })
          : input.reloadSecrets === true
            ? providerRegistry.reloadSecretsAndRefresh(input.instanceId)
            : input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh();
        if (input.refreshModels) {
          const instances = yield* providerInstances.listInstances;
          for (const instance of instances) {
            if (
              !instance.refreshModels ||
              (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
              !providers.some(
                (provider) =>
                  provider.instanceId === instance.instanceId &&
                  provider.enabled &&
                  provider.installed,
              )
            )
              continue;
            yield* instance.refreshModels().pipe(
              Effect.mapError(
                (error) =>
                  new ProviderSetupError({
                    instanceId: instance.instanceId,
                    operation: "refresh-models",
                    detail: error.detail,
                  }),
              ),
            );
            providers = yield* providerRegistry.refreshInstance(instance.instanceId);
          }
        }
        if (input.workspaceSnapshotsOnDemand !== true) return { providers };
        const commandProviders =
          input.usageLimitsCommand === true
            ? withUsageLimitsCommands(providers, yield* usageLimitSources.current)
            : providers;
        const { instanceId, cwd } = input;
        if (instanceId === undefined || cwd === undefined) {
          return { providers: withoutWorkspaceSnapshots(commandProviders) };
        }
        return {
          providers: commandProviders
            .filter((provider) => provider.instanceId === instanceId)
            .map((provider) => ({
              ...provider,
              // Callers read only the cwd snapshot; the config stream carries the rest.
              models: [],
              slashCommands: [],
              skills: [],
              workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
                (snapshot) => snapshot.cwd === cwd,
              ),
            })),
        };
      }),
  }) satisfies WsRpcHandlersCore;
};
