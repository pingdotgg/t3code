import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { rpcInitialItems } from "./rpcInitialItems.ts";
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
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "./serverSettings.ts";
import { terminalOutputStream, withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import { refreshPushedPullRequests } from "./git/refreshPushedPullRequests.ts";
import { linkCreatedPullRequest } from "./git/linkCreatedPullRequest.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { threadWorkspaceRoot } from "./project/threadWorkspaceRoot.ts";
import { requiredScopeForDeviceList, rpcAuthorizationError } from "./auth/RpcAuthorization.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { isNetworkPath } from "@t3tools/shared/path";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import { MAX_CLIENT_APP_VERSION_LENGTH, MAX_CLIENT_BROWSER_LENGTH, MAX_CLIENT_DEVICE_MODEL_LENGTH, PROVIDER_STATUS_DEBOUNCE_MS, filesystemBrowseFailureContext, hasCompatibleOrchestrationProtocol, isClientConnectionMethod, isClientDeviceType, isClientOs, isClientSurface, isClientWebDeployment, persistChatAttachments, projectEntriesFailureContext, projectFileFailureContext, readSettingsClient, toAuthAccessStreamEvent, withoutWorkspaceSnapshots } from "./wsClientContext.ts";
import { isProviderUploadFeedbackError, resolveOpenDiscoveryForConfig, withLateConfigDiscovery } from "./wsConfigDiscovery.ts";
import type { AllWsHandlers, WsHandlerContext } from "./wsHandlerTypes.ts";

// Extracted from ./ws.ts: RPC handlers for workspace.
export type WsRpcHandlersWorkspace = Pick<
  AllWsHandlers,
  typeof WS_METHODS.projectsListEntries | typeof WS_METHODS.projectsListIgnoredFiles | typeof WS_METHODS.projectsReadFile | typeof WS_METHODS.projectsWriteFile | typeof WS_METHODS.projectsMutate | typeof WS_METHODS.shellOpenInEditor | typeof WS_METHODS.filesystemGetMetadata | typeof WS_METHODS.filesystemBrowse | typeof WS_METHODS.attachmentsCreateUploadUrl | typeof WS_METHODS.attachmentsDelete | typeof WS_METHODS.agentSessionsScan | typeof WS_METHODS.agentSessionsImport | typeof WS_METHODS.assetsCreateUrl | typeof WS_METHODS.assetsPersistChatAttachments | typeof WS_METHODS.subscribeVcsStatus | typeof WS_METHODS.subscribeWorktreeSetup | typeof WS_METHODS.worktreeSetupCancel | typeof WS_METHODS.vcsRefreshStatus | typeof WS_METHODS.vcsPull | typeof WS_METHODS.gitRunStackedAction | typeof WS_METHODS.gitResolvePullRequest | typeof WS_METHODS.gitPreparePullRequestThread | typeof WS_METHODS.vcsListRefs | typeof WS_METHODS.vcsCreateWorktree | typeof WS_METHODS.vcsRemoveWorktree | typeof WS_METHODS.vcsCreateRef | typeof WS_METHODS.vcsSwitchRef | typeof WS_METHODS.vcsInit | typeof WS_METHODS.reviewGetBranchCommits | typeof WS_METHODS.reviewGetDiffPreview | typeof WS_METHODS.reviewGetDiffFileContents | typeof WS_METHODS.terminalOpen | typeof WS_METHODS.terminalAttach | typeof WS_METHODS.terminalWrite | typeof WS_METHODS.terminalResize | typeof WS_METHODS.terminalClear | typeof WS_METHODS.terminalClose | typeof WS_METHODS.terminalObserve | typeof WS_METHODS.subscribeTerminalMetadata | typeof WS_METHODS.previewOpen | typeof WS_METHODS.previewResize | typeof WS_METHODS.previewAdjust | typeof WS_METHODS.previewClose | typeof WS_METHODS.previewList | typeof WS_METHODS.previewClearProfile | typeof WS_METHODS.previewReportProfiles | typeof WS_METHODS.previewReportStatus | typeof WS_METHODS.subscribePreviewEvents | typeof WS_METHODS.deviceConfigure | typeof WS_METHODS.deviceTestHost | typeof WS_METHODS.deviceEasAccount | typeof WS_METHODS.deviceSimlockIdentity | typeof WS_METHODS.deviceList | typeof WS_METHODS.deviceOpen | typeof WS_METHODS.deviceClose | typeof WS_METHODS.deviceShutdown | typeof WS_METHODS.deviceDetail | typeof WS_METHODS.deviceAction | typeof WS_METHODS.subscribeDeviceState | typeof WS_METHODS.previewStopLocalServer | typeof WS_METHODS.subscribeDiscoveredLocalServers | typeof WS_METHODS.subscribeServerConfig | typeof WS_METHODS.subscribeServerLifecycle | typeof WS_METHODS.subscribeAuthAccess | typeof WS_METHODS.subscribeResourceTelemetry
>;

export const wsRpcHandlersWorkspace = (ctx: WsHandlerContext) => {
  const { agentSessionImporter, agentSessionScanner, authorizeEffect, bootstrapCredentials, config, currentSessionId, deviceService, directEndpoints, environmentTheme, externalLauncher, gitWorkflow, keybindings, lifecycleEvents, loadAuthAccessSnapshot, loadServerConfig, mutateProject, orchestrationEngine, portDiscovery, previewManager, projectCloneTracker, projectService, projectStore, providerRegistry, pullRequests, refreshGitStatus, remoteOpenTargets, reportProfiles, resourceTelemetry, review, serverBrowser, serverCommandId, serverSettings, sessions, settingsClient, startup, terminalManager, terminalViewerId, threadManagement, usageLimitSources, vcsProvisioning, vcsStatusBroadcaster, workspaceEntries, workspaceFileSystem, worktreeSetupTracker, } = ctx;

  return ({
    [WS_METHODS.projectsListEntries]: (input) =>
      workspaceEntries.list(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectListEntriesError({
              ...input,
              ...projectEntriesFailureContext(cause),
              cause,
            }),
        ),
      ),
    [WS_METHODS.projectsListIgnoredFiles]: (input) =>
      workspaceEntries.listIgnoredFiles(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectListEntriesError({
              ...input,
              ...projectEntriesFailureContext(cause),
              cause,
            }),
        ),
      ),
    [WS_METHODS.projectsReadFile]: (input) =>
      workspaceFileSystem.readFile(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectReadFileError({
              ...input,
              ...projectFileFailureContext(cause),
              cause,
            }),
        ),
      ),
    [WS_METHODS.projectsWriteFile]: (input) =>
      workspaceFileSystem.writeFile(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectWriteFileError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              ...projectFileFailureContext(cause),
              cause,
            }),
        ),
      ),
    [WS_METHODS.projectsMutate]: (mutation) =>
      startup.enqueueCommand(mutateProject(mutation)).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectMutationError({
              commandId: mutation.commandId,
              message:
                cause._tag === "ProjectNotEmptyError"
                  ? cause.message
                  : "Failed to mutate project.",
              cause,
            }),
        ),
      ),
    [WS_METHODS.shellOpenInEditor]: (input) => externalLauncher.launchEditor(input),
    [WS_METHODS.filesystemGetMetadata]: (input) => workspaceFileSystem.getMetadata(input),
    [WS_METHODS.filesystemBrowse]: (input) =>
      workspaceEntries.browse(input).pipe(
        Effect.mapError(
          (cause) =>
            new FilesystemBrowseError({
              ...input,
              ...filesystemBrowseFailureContext(cause),
              cause,
            }),
        ),
      ),
    [WS_METHODS.attachmentsCreateUploadUrl]: (input) => issueAttachmentUploadUrl(input),
    [WS_METHODS.attachmentsDelete]: (input) => deletePendingAttachment(input.attachmentId),
    [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
    [WS_METHODS.agentSessionsImport]: (input) =>
      agentSessionImporter.importRecentAgentThreads(input),
    [WS_METHODS.assetsCreateUrl]:
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (input) {
        const path = yield* Path.Path;
        if (
          input.resource._tag === "attachment" ||
          input.resource._tag === "native-app-icon" ||
          input.resource._tag === "tool-output-image" ||
          input.resource._tag === SOURCE_CONTROL_MEDIA_ASSET ||
          // A network path is served only from the thread's project, looked up below.
          (input.resource._tag === "media-file" &&
            path.isAbsolute(input.resource.path) &&
            !isNetworkPath(input.resource.path))
        ) {
          return yield* issueAssetUrl({ resource: input.resource });
        }
        if (input.resource._tag === "draft-workspace-file") {
          return yield* issueAssetUrl({
            resource: input.resource,
            workspaceRoot: input.resource.cwd,
          });
        }
        if (input.resource._tag === "project-favicon") {
          const project = yield* projectStore
            .findActiveByWorkspaceRoot(input.resource.cwd)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            );
          if (Option.isNone(project)) {
            return yield* new AssetWorkspaceContextNotFoundError({
              resource: input.resource,
            });
          }
          // Clone projects precede their files; clients retry asset URLs after clone completion.
          const clone = yield* projectCloneTracker.get(project.value.projectId);
          return yield* issueAssetUrl({
            resource: input.resource,
            ...(project.value.faviconPath
              ? { projectFaviconPath: project.value.faviconPath }
              : {}),
            ...(clone !== null && clone.destinationPath === project.value.workspaceRoot
              ? { projectCheckout: clone.phase === "done" ? "cloned" : "pending" }
              : {}),
          });
        }
        const thread = yield* threadManagement
          .getThreadRecords(input.resource.threadId, [])
          .pipe(
            Effect.mapError(
              (cause) =>
                new AssetWorkspaceContextResolutionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          );
        const project = yield* projectService.getById(thread.thread.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceContextResolutionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        if (Option.isNone(project)) {
          return yield* new AssetWorkspaceContextNotFoundError({
            resource: input.resource,
          });
        }
        return yield* issueAssetUrl({
          resource: input.resource,
          workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
        });
      }),
    [WS_METHODS.assetsPersistChatAttachments]: (input) =>
      persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
    [WS_METHODS.subscribeVcsStatus]: (input) => vcsStatusBroadcaster.streamStatus(input),
    [WS_METHODS.subscribeWorktreeSetup]: (input) => worktreeSetupTracker.stream(input.threadId),
    [WS_METHODS.worktreeSetupCancel]: (input) =>
      worktreeSetupTracker
        .cancel(input.threadId)
        .pipe(Effect.map((cancelled) => ({ cancelled }))),
    [WS_METHODS.vcsRefreshStatus]: (input) =>
      vcsStatusBroadcaster.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
    [WS_METHODS.vcsPull]: (input) =>
      gitWorkflow.pullCurrentBranch(input.cwd).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Effect.failCause(cause),
          onSuccess: (result) =>
            refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
        }),
      ),
    [WS_METHODS.gitRunStackedAction]: (input) =>
      Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
        gitWorkflow
          .runStackedAction(input, {
            actionId: input.actionId,
            progressReporter: {
              publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
            },
          })
          .pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => Queue.failCause(queue, cause),
              onSuccess: (result) =>
                (input.threadId === undefined
                  ? Effect.void
                  : linkCreatedPullRequest({
                      threadId: input.threadId,
                      result,
                      commandId: serverCommandId("pr-created-link"),
                    }).pipe(
                      Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                      Effect.provideService(ProjectService.ProjectService, projectService),
                    )
                ).pipe(
                  Effect.andThen(
                    refreshPushedPullRequests(input, result).pipe(
                      Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                      Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
                      Effect.provideService(
                        PullRequestService.PullRequestService,
                        pullRequests,
                      ),
                    ),
                  ),
                  Effect.andThen(refreshGitStatus(input.cwd)),
                  Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                ),
            }),
          ),
      ),
    [WS_METHODS.gitResolvePullRequest]: (input) => gitWorkflow.resolvePullRequest(input),
    [WS_METHODS.gitPreparePullRequestThread]: (input) =>
      gitWorkflow
        .preparePullRequestThread(input)
        .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.vcsListRefs]: (input) => gitWorkflow.listRefs(input),
    [WS_METHODS.vcsCreateWorktree]: (input) =>
      gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.vcsRemoveWorktree]: (input) =>
      gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.vcsCreateRef]: (input) =>
      gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.vcsSwitchRef]: (input) =>
      gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.vcsInit]: (input) =>
      vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.reviewGetBranchCommits]: (input) => review.getBranchCommits(input),
    [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
    [WS_METHODS.reviewGetDiffFileContents]: (input) => review.getDiffFileContents(input),
    [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
    [WS_METHODS.terminalAttach]: (input, metadata) =>
      terminalManager.attachOutputStream(input, terminalViewerId(metadata)),
    [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
    [WS_METHODS.terminalResize]: (input, metadata) =>
      terminalManager.resize(input, terminalViewerId(metadata)),
    [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
    [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
    [WS_METHODS.terminalObserve]: (input) =>
      terminalOutputStream(
        (listener, registerCleanup) =>
          terminalManager.observeStream(input, listener, registerCleanup),
        (listener, registerCleanup) =>
          terminalManager.resyncStream(input, listener, registerCleanup),
      ),
    [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
      Stream.callback<TerminalMetadataStreamEvent>((queue) =>
        Effect.acquireRelease(
          terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ),
    [WS_METHODS.previewOpen]: (input) => previewManager.open(input),
    [WS_METHODS.previewResize]: (input) => previewManager.resize(input),
    [WS_METHODS.previewAdjust]: (input) => previewManager.adjust(input),
    [WS_METHODS.previewClose]: (input) => previewManager.close(input),
    [WS_METHODS.previewList]: (input) => previewManager.list(input),
    [WS_METHODS.previewClearProfile]: (input) => serverBrowser.clearProfile(input.profileId),
    [WS_METHODS.previewReportProfiles]: (input) => reportProfiles(input),
    [WS_METHODS.previewReportStatus]: (input) => previewManager.reportStatus(input),
    [WS_METHODS.subscribePreviewEvents]: (_input) => previewManager.events,
    [WS_METHODS.deviceConfigure]: (input) => deviceService.configure(input),
    [WS_METHODS.deviceTestHost]: (input) => deviceService.testHost(input),
    [WS_METHODS.deviceEasAccount]: (input) => deviceService.easAccount(input),
    [WS_METHODS.deviceSimlockIdentity]: (input) => deviceService.simlockIdentity(input),
    [WS_METHODS.deviceList]: (input) =>
      input.inspectOnly && !input.updateTool
        ? deviceService.inspect
        : authorizeEffect(
            requiredScopeForDeviceList(input),
            input.updateTool
              ? deviceService.updateTool(input.updateTool)
              : input.retryHostId
                ? deviceService.retryHost(input.retryHostId)
                : deviceService.list,
          ),
    [WS_METHODS.deviceOpen]: (input) =>
      threadWorkspaceRoot(input.threadId).pipe(
        Effect.flatMap((workspaceRoot) => deviceService.open(input, { workspaceRoot })),
      ),
    [WS_METHODS.deviceClose]: (input) => deviceService.close(input),
    [WS_METHODS.deviceShutdown]: (input) => deviceService.shutdown(input),
    [WS_METHODS.deviceDetail]: (input) => deviceService.detail(input),
    [WS_METHODS.deviceAction]: (input) => deviceService.action(input),
    [WS_METHODS.subscribeDeviceState]: (_input) => DeviceService.stateStream(deviceService),
    [WS_METHODS.previewStopLocalServer]: (input) => portDiscovery.stopServer(input),
    [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
      Stream.callback<DiscoveredLocalServerList>((queue) =>
        Effect.gen(function* () {
          const configuredUrls = input.configuredUrls ?? [];
          yield* portDiscovery.retain;
          const initial = yield* portDiscovery.scan(configuredUrls);
          const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Queue.offer(queue, {
            servers: initial,
            scannedAt: initialScannedAt,
            configuredUrlProbing: true,
          });
          yield* portDiscovery.subscribe(
            { configuredUrls, initialSnapshot: initial },
            (servers) =>
              Effect.gen(function* () {
                const scannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers,
                  scannedAt,
                  configuredUrlProbing: true,
                });
              }),
          );
        }),
      ),
    [WS_METHODS.subscribeServerConfig]: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const usageLimitsCommand = input.usageLimitsCommand === true;
          const workspaceSnapshotsOnDemand = input.workspaceSnapshotsOnDemand === true;
          // Buffer changes through discovery and the initial snapshot's RPC ACK wait.
          const keybindingsChanges = yield* keybindings.subscribeChanges;
          const settingsChanges = yield* serverSettings.subscribeChanges;
          const remoteTargets = yield* Effect.forkScoped(remoteOpenTargets.resolveTargets(), {
            startImmediately: true,
          });
          const directResult = yield* Effect.forkScoped(
            directEndpoints
              .resolve()
              .pipe(Effect.catchCause(() => directEndpoints.resolveAvailable())),
            { startImmediately: true },
          );
          const config = yield* loadServerConfig({
            usageLimitsCommand,
            workspaceSnapshotsOnDemand,
            deferNetworkDiscovery: true,
          });
          const keybindingsUpdates = keybindingsChanges.pipe(
            Stream.map((event) => ({
              version: 1 as const,
              type: "keybindingsUpdated" as const,
              payload: {
                keybindings: event.keybindings,
                issues: event.issues,
              },
            })),
          );
          const providerStatuses = Stream.zipLatestWith(
            // Seed the changes-only stream so early source refreshes pair with current providers.
            Stream.concat(
              Stream.fromEffect(providerRegistry.getProviders),
              providerRegistry.streamChanges,
            ),
            usageLimitSources.streamChanges.pipe(
              Stream.changesWith(
                usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true,
              ),
            ),
            (providers, sources) => {
              const commandProviders = usageLimitsCommand
                ? withUsageLimitsCommands(providers, sources)
                : providers;
              // Stripped before the de-dupe below, so snapshot-only changes send nothing.
              return workspaceSnapshotsOnDemand
                ? withoutWorkspaceSnapshots(commandProviders)
                : commandProviders;
            },
          ).pipe(
            // Compare initial paired values with the snapshot; blindly dropping them loses changes between snapshot and subscription.
            (updates) => Stream.concat(rpcInitialItems([config.providers]), updates),
            Stream.changesWith(
              (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
            ),
            Stream.drop(1),
            Stream.map((providers) => ({
              version: 1 as const,
              type: "providerStatuses" as const,
              payload: { providers },
            })),
            Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
          );
          // Gate capability-specific events; older clients reject them and lose their config subscription.
          const environmentThemeUpdates =
            input.environmentThemes === true
              ? environmentTheme.streamChanges.pipe(
                  Stream.map((themes) => ({
                    version: 1 as const,
                    type: "environmentThemesUpdated" as const,
                    payload: { themes },
                  })),
                )
              : Stream.empty;
          const usageLimitSourceUpdates =
            input.usageLimitSources === true
              ? usageLimitSources.streamChanges.pipe(
                  Stream.map((sources) => ({
                    version: 1 as const,
                    type: "usageLimitSourcesUpdated" as const,
                    payload: { sources },
                  })),
                )
              : Stream.empty;
          const settingsUpdates = settingsChanges.pipe(
            Stream.map((settings) =>
              ServerSettings.redactServerSettingsForClient(settings, settingsClient),
            ),
            Stream.map((settings) => ({
              version: 1 as const,
              type: "settingsUpdated" as const,
              payload: { settings },
            })),
          );

          const liveUpdates = Stream.merge(
            keybindingsUpdates,
            Stream.merge(
              providerStatuses,
              Stream.merge(
                settingsUpdates,
                Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
              ),
            ),
          );

          const remoteResult = yield* Effect.sync(() => remoteTargets.pollUnsafe());
          const initialConfig =
            remoteResult?._tag === "Success"
              ? { ...config, remoteOpenTargets: remoteResult.value }
              : config;
          return Stream.concat(
            rpcInitialItems([
              { version: 1 as const, type: "snapshot" as const, config: initialConfig },
            ]),
            withLateConfigDiscovery(
              initialConfig,
              liveUpdates,
              externalLauncher,
              {
                resolveTargets: () => Fiber.join(remoteTargets),
              },
              { resolve: () => Fiber.join(directResult) },
            ),
          );
        }),
      ),
    [WS_METHODS.subscribeServerLifecycle]: (_input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
          yield* Effect.forkScoped(
            lifecycleEvents.stream.pipe(
              Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
            ),
            { startImmediately: true },
          );
          const snapshot = yield* lifecycleEvents.snapshot;
          const snapshotEvents = Array.from(snapshot.events).toSorted(
            (left, right) => left.sequence - right.sequence,
          );
          const liveEvents = Stream.fromQueue(liveBuffer).pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          );
          return Stream.concat(rpcInitialItems(snapshotEvents), liveEvents);
        }),
      ),
    [WS_METHODS.subscribeAuthAccess]: (_input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const initialSnapshot = yield* loadAuthAccessSnapshot();
          const revisionRef = yield* Ref.make(1);
          const accessChanges: Stream.Stream<
            PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
          > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

          const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
            Stream.mapEffect((change) =>
              Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                Effect.map((revision) =>
                  toAuthAccessStreamEvent(change, revision, currentSessionId),
                ),
              ),
            ),
          );

          return Stream.concat(
            rpcInitialItems([
              {
                version: 1 as const,
                revision: 1,
                type: "snapshot" as const,
                payload: initialSnapshot,
              },
            ]),
            liveEvents,
          );
        }),
      ),
    [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
      Stream.unwrap(
        Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
          Stream.concat(Stream.make(latest), changes),
        ),
      ),
  }) satisfies WsRpcHandlersWorkspace;
};
