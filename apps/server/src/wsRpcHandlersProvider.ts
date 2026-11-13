import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { subscribeChatGptHandoff } from "./provider/CodexChatGptHandoff.ts";
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
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerSettings from "./serverSettings.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { MAX_CLIENT_APP_VERSION_LENGTH, MAX_CLIENT_BROWSER_LENGTH, MAX_CLIENT_DEVICE_MODEL_LENGTH, PROVIDER_STATUS_DEBOUNCE_MS, filesystemBrowseFailureContext, hasCompatibleOrchestrationProtocol, isClientConnectionMethod, isClientDeviceType, isClientOs, isClientSurface, isClientWebDeployment, persistChatAttachments, projectEntriesFailureContext, projectFileFailureContext, readSettingsClient, toAuthAccessStreamEvent, withoutWorkspaceSnapshots } from "./wsClientContext.ts";
import { isProviderUploadFeedbackError, resolveOpenDiscoveryForConfig, withLateConfigDiscovery } from "./wsConfigDiscovery.ts";
import type { AllWsHandlers, WsHandlerContext } from "./wsHandlerTypes.ts";

// Extracted from ./ws.ts: RPC handlers for provider.
export type WsRpcHandlersProvider = Pick<
  AllWsHandlers,
  typeof WS_METHODS.mcpAppsCallTool | typeof WS_METHODS.mcpAppsToolInfo | typeof WS_METHODS.mcpAppsUpdateModelContext | typeof WS_METHODS.mcpAppsReadResource | typeof WS_METHODS.providerUploadFeedback | typeof WS_METHODS.serverUpdateProvider | typeof WS_METHODS.providerConsumeResetCredit | typeof WS_METHODS.providerAuthStart | typeof WS_METHODS.providerAuthRespond | typeof WS_METHODS.providerAuthComplete | typeof WS_METHODS.chatGptReconnectProfile | typeof WS_METHODS.chatGptImportProfile | typeof WS_METHODS.chatGptHandoffSubscribe | typeof WS_METHODS.providerAuthCancel | typeof WS_METHODS.providerAuthLogout | typeof WS_METHODS.providerAuthSubscribe | typeof WS_METHODS.providerInstallStart | typeof WS_METHODS.providerInstallCancel | typeof WS_METHODS.providerInstallSubscribe | typeof WS_METHODS.providerInstallRemove | typeof WS_METHODS.serverUpdateServer | typeof WS_METHODS.serverGetNpmRelease | typeof WS_METHODS.serverUpdateServerWithProgress | typeof WS_METHODS.serverCommitDesktopUpdate | typeof WS_METHODS.serverUpsertKeybinding | typeof WS_METHODS.serverRemoveKeybinding | typeof WS_METHODS.serverRunStorageCleanup | typeof WS_METHODS.serverGetStorageCleanupReport | typeof WS_METHODS.serverGetDatabaseStorage | typeof WS_METHODS.peerLinksList | typeof WS_METHODS.peerLinksLink | typeof WS_METHODS.peerLinksUnlink | typeof WS_METHODS.peerLinksAnswerRequest | typeof WS_METHODS.serverUpdateSettings | typeof WS_METHODS.serverDiscoverSourceControl | typeof WS_METHODS.serverGetTraceDiagnostics | typeof WS_METHODS.serverGetProcessDiagnostics | typeof WS_METHODS.serverGetHostResources | typeof WS_METHODS.serverGetProcessResourceHistory | typeof WS_METHODS.serverGetResourceTelemetryHistory | typeof WS_METHODS.serverGetUsageSummary | typeof WS_METHODS.serverRefreshUsageRates | typeof WS_METHODS.serverRetryResourceTelemetry | typeof WS_METHODS.serverCheckOtlpEndpoint | typeof WS_METHODS.serverPrepareTriage | typeof WS_METHODS.serverSignalProcess | typeof WS_METHODS.serverReportClientActivity | typeof WS_METHODS.cloudGetRelayClientStatus | typeof WS_METHODS.cloudInstallRelayClient | typeof WS_METHODS.pullRequestsList | typeof WS_METHODS.pullRequestsListStats | typeof WS_METHODS.pullRequestsFilterOptions | typeof WS_METHODS.pullRequestsRoutingIdentity | typeof WS_METHODS.pullRequestsRouting | typeof WS_METHODS.pullRequestsSummary | typeof WS_METHODS.pullRequestsStack | typeof WS_METHODS.pullRequestsLinkedThreads | typeof WS_METHODS.pullRequestsDetail | typeof WS_METHODS.pullRequestsPreview | typeof WS_METHODS.pullRequestsChecks | typeof WS_METHODS.pullRequestsActivity | typeof WS_METHODS.pullRequestsReviewGuide | typeof WS_METHODS.pullRequestsGenerateReviewGuide | typeof WS_METHODS.pullRequestsThreadComments | typeof WS_METHODS.pullRequestsDiffFileContents | typeof WS_METHODS.pullRequestsFilesViewed | typeof WS_METHODS.pullRequestsChangeBreakdown | typeof WS_METHODS.pullRequestsSetFilesViewed | typeof WS_METHODS.pullRequestsRunAction | typeof WS_METHODS.pullRequestsUpdate | typeof WS_METHODS.pullRequestsComment | typeof WS_METHODS.pullRequestsUpdateComment | typeof WS_METHODS.pullRequestsSubmitReview | typeof WS_METHODS.pullRequestsReplyToThread | typeof WS_METHODS.pullRequestsSetThreadResolution | typeof WS_METHODS.pullRequestsSetReaction | typeof WS_METHODS.pullRequestsReportState | typeof WS_METHODS.pullRequestsInvalidate | typeof WS_METHODS.pullRequestsSubscribeRefreshes | typeof WS_METHODS.pullRequestsReviewerCandidates | typeof WS_METHODS.pullRequestsRequestReviewers | typeof WS_METHODS.pullRequestsLabelCandidates | typeof WS_METHODS.pullRequestsSetLabels | typeof WS_METHODS.sourceControlLookupRepository | typeof WS_METHODS.sourceControlCloneRepository | typeof WS_METHODS.sourceControlSignInStart | typeof WS_METHODS.sourceControlSignInWait | typeof WS_METHODS.sourceControlSignInCancel | typeof WS_METHODS.sourceControlAppAccess | typeof WS_METHODS.sourceControlStarred | typeof WS_METHODS.sourceControlStar | typeof WS_METHODS.projectCloneStart | typeof WS_METHODS.projectsEnsureScratch | typeof WS_METHODS.projectsCreateNew | typeof WS_METHODS.projectsCreateFromThread | typeof WS_METHODS.projectCloneCancel | typeof WS_METHODS.projectCloneRetry | typeof WS_METHODS.subscribeProjectClones | typeof WS_METHODS.sourceControlPublishRepository | typeof WS_METHODS.projectsSearchEntries | typeof WS_METHODS.projectsSearchContents
>;

export const wsRpcHandlersProvider = (ctx: WsHandlerContext) => {
  const { backgroundPolicy, config, currentSessionId, databaseStorage, deviceHostContext, hostResources, keybindings, managedFolders, mcpAppRequests, npmRelease, otlpEndpointCheck, peerLinkRequests, peerLinks, processDiagnostics, processResourceMonitor, projectCloneTracker, projectEnrichment, projectService, providerAuth, providerInstallation, providerInstances, providerMaintenanceRunner, providerSessionsV2, pullRequestSync, pullRequests, refreshGitStatus, relayClient, repositoryIdentityResolver, resolvePullRequestSyncKey, resourceTelemetry, reviewGuides, rpcClientIds, scratchThreadPromotion, serverSelfUpdate, serverSettings, settingsClient, sourceControlDiscovery, sourceControlRepositories, sourceControlSignIn, sql, storageCleanup, threadManagement, triage, usage, usageLimitSources, withPullRequestViewer, workspaceEntries, } = ctx;

  return ({
    [WS_METHODS.mcpAppsCallTool]: (input) => mcpAppRequests.callTool(input),
    [WS_METHODS.mcpAppsToolInfo]: (input) => mcpAppRequests.toolInfo(input),
    [WS_METHODS.mcpAppsUpdateModelContext]: (input) => mcpAppRequests.updateModelContext(input),
    [WS_METHODS.mcpAppsReadResource]: (input) => mcpAppRequests.readResource(input),
    [WS_METHODS.providerUploadFeedback]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(
        function* (input) {
          const projection = yield* threadManagement.getThreadRecords(input.threadId, [
            "providerThreads",
          ]);
          const providerThread =
            projection.providerThreads.find(
              (candidate) => candidate.id === projection.thread.activeProviderThreadId,
            ) ?? projection.providerThreads.at(-1);
          const providerSessionId = providerThread?.providerSessionId ?? null;
          if (providerThread === undefined || providerSessionId === null) {
            return yield* new ProviderUploadFeedbackError({
              threadId: input.threadId,
              cause: "No provider session has run in this thread yet.",
            });
          }
          const runtime = Option.getOrNull(yield* providerSessionsV2.get(providerSessionId));
          if (runtime === null) {
            return yield* new ProviderUploadFeedbackError({
              threadId: input.threadId,
              cause: "The provider session is no longer running. Send a message first.",
            });
          }
          if (runtime.uploadFeedback === undefined) {
            return yield* new ProviderUploadFeedbackError({
              threadId: input.threadId,
              cause: `Provider '${runtime.driver}' does not support feedback uploads.`,
            });
          }
          return yield* runtime.uploadFeedback({
            providerThread,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderUploadFeedbackError(cause)
                ? cause
                : new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause,
                  }),
            ),
          ),
      ),
    [WS_METHODS.serverUpdateProvider]: (input) =>
      providerMaintenanceRunner.updateProvider(input),
    [WS_METHODS.providerConsumeResetCredit]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (input) {
        if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
        const instance = yield* providerInstances.getInstance(input.instanceId);
        if (instance === undefined || !instance.enabled) {
          return yield* new ProviderSetupError({
            instanceId: input.instanceId,
            operation: "consume-reset-credit",
            detail: instance ? "This provider is disabled." : "Provider instance not found.",
          });
        }
        if (instance.consumeResetCredit === undefined) {
          return yield* new ProviderSetupError({
            instanceId: input.instanceId,
            operation: "consume-reset-credit",
            detail: "This provider does not bank reset credits.",
          });
        }
        const outcome = yield* instance.consumeResetCredit().pipe(
          Effect.mapError(
            (error) =>
              new ProviderSetupError({
                instanceId: input.instanceId,
                operation: "consume-reset-credit",
                detail: error.detail,
                cause: error,
              }),
          ),
        );
        return { outcome };
      }),
    [WS_METHODS.providerAuthStart]: (input) => providerAuth.start(input, currentSessionId),
    [WS_METHODS.providerAuthRespond]: (input) =>
      Effect.annotateCurrentSpan({ instanceId: input.instanceId }).pipe(
        Effect.andThen(providerAuth.respond(input, currentSessionId)),
      ),
    [WS_METHODS.providerAuthComplete]: (input) =>
      providerAuth.complete(input, currentSessionId),
    [WS_METHODS.chatGptReconnectProfile]: (input) => providerAuth.reconnectProfile(input),
    [WS_METHODS.chatGptImportProfile]: (input) => providerAuth.importProfile(input),
    [WS_METHODS.chatGptHandoffSubscribe]: (input) =>
      subscribeChatGptHandoff(input, currentSessionId),
    [WS_METHODS.providerAuthCancel]: (input) => providerAuth.cancel(input, currentSessionId),
    [WS_METHODS.providerAuthLogout]: (input) => providerAuth.logout(input),
    [WS_METHODS.providerAuthSubscribe]: (input) =>
      providerAuth.subscribe(input, currentSessionId),
    [WS_METHODS.providerInstallStart]: (input) => providerInstallation.start(input),
    [WS_METHODS.providerInstallCancel]: (input) => providerInstallation.cancel(input),
    [WS_METHODS.providerInstallSubscribe]: (input) => providerInstallation.subscribe(input),
    [WS_METHODS.providerInstallRemove]: (input) => providerInstallation.remove(input),
    [WS_METHODS.serverUpdateServer]: (input) => serverSelfUpdate.update(input),
    [WS_METHODS.serverGetNpmRelease]: (input) => npmRelease.get(input),
    [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
      ServerSelfUpdate.updateProgressStream(serverSelfUpdate, input),
    [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
      serverSelfUpdate.commitDesktopUpdate(input.requestId),
    [WS_METHODS.serverUpsertKeybinding]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (rule) {
        return yield* keybindings.upsertKeybindingRule(rule);
      }),
    [WS_METHODS.serverRemoveKeybinding]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (rule) {
        return yield* keybindings.removeKeybindingRule(rule);
      }),
    [WS_METHODS.serverRunStorageCleanup]: () => storageCleanup.runNow,
    [WS_METHODS.serverGetStorageCleanupReport]: () => storageCleanup.reports,
    [WS_METHODS.serverGetDatabaseStorage]: () => databaseStorage.status,
    [WS_METHODS.peerLinksList]: (_input) =>
      peerLinks.list.pipe(Effect.map((links) => ({ links }))),
    [WS_METHODS.peerLinksLink]: (input) => peerLinks.link(input),
    [WS_METHODS.peerLinksUnlink]: ({ environmentId }) =>
      peerLinks.unlink(environmentId).pipe(Effect.map((removed) => ({ removed }))),
    [WS_METHODS.peerLinksAnswerRequest]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(peerLinkRequests.answer(input)),
      ),
    [WS_METHODS.serverUpdateSettings]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* ({ patch, providerInstanceMutation }) {
        const deviceHosts = patch.deviceHosts
          ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(
              Effect.provide(deviceHostContext),
            )
          : undefined;
        const nextPatch = { ...patch, ...(deviceHosts ? { deviceHosts } : {}) };
        const settings = yield* providerInstanceMutation === undefined
          ? serverSettings.updateSettings(nextPatch)
          : serverSettings.updateProviderInstance(providerInstanceMutation, nextPatch);
        return ServerSettings.redactServerSettingsForClient(settings, settingsClient);
      }),
    [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
    [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
      TraceDiagnostics.readTraceDiagnostics({
        traceFilePath: config.serverTracePath,
        maxFiles: config.traceMaxFiles,
      }),
    [WS_METHODS.serverGetProcessDiagnostics]: (_input) => processDiagnostics.read,
    [WS_METHODS.serverGetHostResources]: (_input) => hostResources.read,
    [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
      processResourceMonitor.readHistory(input),
    [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
      resourceTelemetry.readHistory(input),
    [WS_METHODS.serverGetUsageSummary]: (input) => usage.readSummary(input),
    [WS_METHODS.serverRefreshUsageRates]: (_input) => usage.refreshRates,
    [WS_METHODS.serverRetryResourceTelemetry]: (_input) => resourceTelemetry.retry,
    [WS_METHODS.serverCheckOtlpEndpoint]: (input) => otlpEndpointCheck.check(input),
    [WS_METHODS.serverPrepareTriage]: (input) => triage.prepare(input),
    [WS_METHODS.serverSignalProcess]: (input) => processDiagnostics.signal(input),
    [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
      Ref.update(rpcClientIds, (clientIds) => {
        const next = new Set(clientIds);
        next.add(RpcClientId.make(metadata.client.id));
        return next;
      }).pipe(
        Effect.andThen(
          backgroundPolicy.reportClientActivity(
            currentSessionId,
            RpcClientId.make(metadata.client.id),
            input,
          ),
        ),
      ),
    [WS_METHODS.cloudGetRelayClientStatus]: (_input) => relayClient.resolve,
    [WS_METHODS.cloudInstallRelayClient]: (_input) =>
      Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>((queue) =>
        relayClient
          .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
          .pipe(
            Effect.flatMap((status) =>
              Queue.offer(queue, {
                type: "complete",
                status,
              }),
            ),
            Effect.catchTags({
              RelayClientInstallError: (error) =>
                Queue.fail(
                  queue,
                  new RelayClientInstallFailedError({
                    reason: error.reason,
                    message: error.message,
                  }),
                ),
            }),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
      ),
    [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
    [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
    [WS_METHODS.pullRequestsFilterOptions]: (input) => pullRequests.filterOptions(input),
    [WS_METHODS.pullRequestsRoutingIdentity]: (input) => pullRequests.routingIdentity(input),
    [WS_METHODS.pullRequestsRouting]: (input) => pullRequests.routing(input),
    [WS_METHODS.pullRequestsSummary]: (input) =>
      withPullRequestViewer(input, pullRequests.summary(input)),
    [WS_METHODS.pullRequestsStack]: (input) =>
      withPullRequestViewer(input, pullRequests.stack(input)),
    [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
      resolvePullRequestSyncKey(input).pipe(
        Effect.flatMap((key) =>
          key === null
            ? Effect.succeed({ threads: [] })
            : listLinkedPullRequestThreads(key).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
        ),
      ),
    [WS_METHODS.pullRequestsDetail]: (input) =>
      withPullRequestViewer(input, pullRequests.detail(input)),
    [WS_METHODS.pullRequestsPreview]: (input) =>
      withPullRequestViewer(input, pullRequests.preview(input)),
    [WS_METHODS.pullRequestsChecks]: (input) =>
      withPullRequestViewer(input, pullRequests.checks(input)),
    [WS_METHODS.pullRequestsActivity]: (input) =>
      withPullRequestViewer(input, pullRequests.activity(input)),
    [WS_METHODS.pullRequestsReviewGuide]: (input) =>
      withPullRequestViewer(input, reviewGuides.get(input)),
    [WS_METHODS.pullRequestsGenerateReviewGuide]: (input) =>
      withPullRequestViewer(input, reviewGuides.generate(input)),
    [WS_METHODS.pullRequestsThreadComments]: (input) =>
      withPullRequestViewer(input, pullRequests.threadComments(input)),
    [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
      withPullRequestViewer(input, pullRequests.diffFileContents(input)),
    [WS_METHODS.pullRequestsFilesViewed]: (input) =>
      withPullRequestViewer(input, pullRequests.filesViewed(input)),
    [WS_METHODS.pullRequestsChangeBreakdown]: (input) =>
      withPullRequestViewer(input, pullRequests.changeBreakdown(input)),
    [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
      withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
    [WS_METHODS.pullRequestsRunAction]: (input) =>
      withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
        Effect.tap(() =>
          resolvePullRequestSyncKey(input).pipe(
            Effect.flatMap((key) =>
              key === null ? Effect.void : pullRequestSync.requestSync(key),
            ),
          ),
        ),
      ),
    [WS_METHODS.pullRequestsUpdate]: (input) =>
      withPullRequestViewer(input, pullRequests.update(input)),
    [WS_METHODS.pullRequestsComment]: (input) =>
      withPullRequestViewer(input, pullRequests.comment(input)),
    [WS_METHODS.pullRequestsUpdateComment]: (input) =>
      withPullRequestViewer(input, pullRequests.updateComment(input)),
    [WS_METHODS.pullRequestsSubmitReview]: (input) =>
      withPullRequestViewer(input, pullRequests.submitReview(input)),
    [WS_METHODS.pullRequestsReplyToThread]: (input) =>
      withPullRequestViewer(input, pullRequests.replyToThread(input)),
    [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
      withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
    [WS_METHODS.pullRequestsSetReaction]: (input) =>
      withPullRequestViewer(input, pullRequests.setReaction(input)),
    [WS_METHODS.pullRequestsReportState]: (input) => pullRequests.reportState(input),
    [WS_METHODS.pullRequestsInvalidate]: (input) =>
      pullRequests
        .invalidate(input, { notifyReaders: true })
        .pipe(
          Effect.andThen(
            input.reference === undefined || input.filesViewedOnly === true
              ? Effect.void
              : resolvePullRequestSyncKey(input.reference).pipe(
                  Effect.flatMap((key) =>
                    key === null ? Effect.void : pullRequestSync.requestSync(key),
                  ),
                ),
          ),
        ),
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => pullRequests.subscribeRefreshes,
    [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
      withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
    [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
      withPullRequestViewer(input, pullRequests.requestReviewers(input)),
    [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
      withPullRequestViewer(input, pullRequests.labelCandidates(input)),
    [WS_METHODS.pullRequestsSetLabels]: (input) =>
      withPullRequestViewer(input, pullRequests.setLabels(input)),
    [WS_METHODS.sourceControlLookupRepository]: (input) =>
      sourceControlRepositories.lookupRepository(input),
    [WS_METHODS.sourceControlCloneRepository]: (input) =>
      sourceControlRepositories.cloneRepository(input),
    [WS_METHODS.sourceControlSignInStart]: (input) => sourceControlSignIn.start(input),
    [WS_METHODS.sourceControlSignInWait]: (input) => sourceControlSignIn.wait(input),
    [WS_METHODS.sourceControlSignInCancel]: (input) => sourceControlSignIn.cancel(input),
    [WS_METHODS.sourceControlAppAccess]: (input) => sourceControlSignIn.access(input),
    [WS_METHODS.sourceControlStarred]: (input) => sourceControlSignIn.starred(input),
    [WS_METHODS.sourceControlStar]: (input) => sourceControlSignIn.star(input),
    [WS_METHODS.projectCloneStart]: (input) =>
      projectCloneTracker.start(input, {
        createProject: (project) =>
          projectService
            .create({
              commandId: CommandId.make(`project-clone-create:${project.projectId}`),
              projectId: project.projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              createWorkspaceRootIfMissing: true,
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: "Failed to create clone project.",
                    cause,
                  }),
              ),
            ),
        onCloned: (project) =>
          repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
            Effect.andThen(
              projectService.update({
                commandId: CommandId.make(`project-clone-done:${project.projectId}`),
                projectId: project.projectId,
              }),
            ),
            Effect.andThen(refreshGitStatus(project.workspaceRoot)),
            // The folder was empty when the project was created, so the cached
            // enrichment says "no repository" and clients cannot group it yet.
            Effect.andThen(projectEnrichment.invalidate([project.workspaceRoot])),
            Effect.andThen(projectEnrichment.request(project.workspaceRoot)),
            Effect.ignoreCause({ log: true }),
          ),
      }),
    [WS_METHODS.projectsEnsureScratch]: () =>
      managedFolders.ensureScratchProject.pipe(
        Effect.mapError(
          (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
        ),
      ),
    [WS_METHODS.projectsCreateNew]: (input) =>
      managedFolders
        .createNamedProject(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
          ),
        ),
    [WS_METHODS.projectsCreateFromThread]: (input) =>
      scratchThreadPromotion
        .promote(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
          ),
        ),
    [WS_METHODS.projectCloneCancel]: (input) =>
      projectCloneTracker.cancel(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
    [WS_METHODS.projectCloneRetry]: (input) =>
      projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
    [WS_METHODS.subscribeProjectClones]: () => projectCloneTracker.stream,
    [WS_METHODS.sourceControlPublishRepository]: (input) =>
      sourceControlRepositories.publishRepository(input).pipe(
        Effect.tap(() => repositoryIdentityResolver.resolve(input.cwd, { refresh: true })),
        Effect.tap(() => refreshGitStatus(input.cwd)),
      ),
    [WS_METHODS.projectsSearchEntries]: (input) =>
      workspaceEntries.search(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSearchEntriesError({
              cwd: input.cwd,
              queryLength: input.query.length,
              limit: input.limit,
              ...projectEntriesFailureContext(cause),
              cause,
            }),
        ),
      ),
    [WS_METHODS.projectsSearchContents]: (input) =>
      workspaceEntries.searchContents(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSearchContentsError({
              cwd: input.cwd,
              queryLength: input.query.length,
              limit: input.limit,
              ...projectEntriesFailureContext(cause),
              cause,
            }),
        ),
      ),
  }) satisfies WsRpcHandlersProvider;
};
