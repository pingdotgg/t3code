import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type ApplicationStoredEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  CommandId,
  type DiscoveredLocalServerList,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type MessageId,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
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
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  ChatAttachmentId,
  PersistChatAttachmentsError,
  RpcClientId,
  EnvironmentAuthorizationError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import {
  archivedShellStreamItemFromThreadShell,
  buildActiveShellSnapshot,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
} from "./orchestration-v2/ShellStream.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import {
  decideThreadResume,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./orchestration-v2/ThreadStream.ts";
import {
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import {
  mergeSubagentTreeProjection,
  routeSubagentTreeEvent,
} from "./orchestration-v2/SubagentTreeProjection.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEventStore from "./persistence/Services/OrchestrationEventStore.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { attachmentRelativePath, createDeterministicAttachmentId } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";

const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5);

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  );

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

const persistChatAttachments = Effect.fn("ws.assets.persistChatAttachments")(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachments: ReadonlyArray<{
    readonly type: "image";
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly dataUrl: string;
  }>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.attachments.map((attachment, index) => ({ attachment, index })),
    Effect.fn("ws.assets.persistChatAttachment")(function* ({ attachment, index }) {
      const parsed = parseBase64DataUrl(attachment.dataUrl);
      if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} has an invalid image payload.`,
        });
      }
      const bytes = yield* Effect.fromResult(Encoding.decodeBase64(parsed.base64)).pipe(
        Effect.mapError(
          (cause) =>
            new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} is not valid base64.`,
              cause,
            }),
        ),
      );
      if (bytes.byteLength !== attachment.sizeBytes) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} size does not match its payload.`,
        });
      }
      const rawId = createDeterministicAttachmentId(input.threadId, `${input.messageId}:${index}`);
      if (rawId === null) {
        return yield* new PersistChatAttachmentsError({
          message: "Could not allocate an attachment identifier.",
        });
      }
      const persisted = {
        type: "image" as const,
        id: ChatAttachmentId.make(rawId),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      yield* fileSystem
        .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(persisted)), bytes)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Could not persist attachment ${attachment.name}.`,
                cause,
              }),
          ),
        );
      return persisted;
    }),
    { concurrency: 2 },
  );
});

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

const ServerWsRpcGroup = WsRpcGroup;
// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  ServerWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const sql = yield* SqlClient.SqlClient;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
      const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
        (projects: ReadonlyArray<OrchestrationProjectShell>) =>
          Effect.forEach(
            projects,
            (project) =>
              // Non-blocking: emit with cached identity (or null) and schedule
              // background resolution. subscribeChanges is attached before
              // loadSnapshot, so later identity completions push refreshed
              // shells for multi-env grouping without blocking the initial
              // snapshot or completion marker on slow git probes.
              projectEnrichment.getAvailable(project.workspaceRoot).pipe(
                Effect.map((enrichment) => ({
                  project: {
                    ...project,
                    repositoryIdentity: enrichment.repositoryIdentity,
                  },
                  repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
                })),
              ),
            { concurrency: 16 },
          ).pipe(
            Effect.map((enriched) => ({
              projects: enriched.map((entry) => entry.project),
              resolvedRepositoryIdentityRoots: enriched
                .filter((entry) => entry.repositoryIdentityResolved)
                .map((entry) => entry.project.workspaceRoot),
            })),
          ),
      );
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const usage = yield* UsageService.UsageService;
      const projectService = yield* ProjectService.ProjectService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
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

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          ),
          // Same discovery-with-timeout treatment as editors: a slow probe
          // must not stall server.getConfig, so it degrades to no targets.
          remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
            remoteOpenTargets.resolveTargets(),
          ),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
        function* (input: {
          readonly threadId: ThreadId;
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: boolean;
        }) {
          yield* Effect.annotateCurrentSpan({
            "orchestration_v2.thread_id": input.threadId,
          });
          yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to hydrate migrated thread ${input.threadId}`,
                  cause,
                }),
            ),
          );

          const loadSubagentTree = Effect.fn("ws.orchestrationV2.loadSubagentTree")(function* (
            root: OrchestrationV2ThreadProjection,
          ) {
            const threadIds = new Set<ThreadId>([root.thread.id]);
            const descendants: OrchestrationV2ThreadProjection[] = [];
            let frontier = root.subagents.flatMap((subagent) =>
              subagent.childThreadId === null ? [] : [subagent.childThreadId],
            );

            while (frontier.length > 0) {
              const nextIds = [...new Set(frontier)].filter((threadId) => !threadIds.has(threadId));
              if (nextIds.length === 0) break;
              for (const threadId of nextIds) threadIds.add(threadId);
              const projections = yield* Effect.forEach(
                nextIds,
                (threadId) => threadManagement.getThreadProjection(threadId),
                { concurrency: 8 },
              );
              descendants.push(...projections);
              frontier = projections.flatMap((projection) =>
                projection.subagents.flatMap((subagent) =>
                  subagent.childThreadId === null ? [] : [subagent.childThreadId],
                ),
              );
            }

            return {
              threadIds,
              projection: mergeSubagentTreeProjection(root, descendants),
            };
          });

          const eventStreamFrom = (
            afterSequence: number,
            initialThreadIds: ReadonlySet<ThreadId>,
          ) =>
            applicationEvents.streamApplicationEvents({ afterSequence }).pipe(
              Stream.mapAccum(
                () => ({ rootThreadId: input.threadId, threadIds: initialThreadIds }),
                routeSubagentTreeEvent,
              ),
              Stream.map((stored) => ({
                kind: "event" as const,
                sequence: stored.sequence,
                event: projectDomainEventForWire(stored.event),
              })),
              Stream.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                    cause,
                  }),
              ),
            );

          const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
            applicationEvents
              .readAgentEvents({
                threadId: input.threadId,
                afterSequence,
                throughSequence,
                limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
              })
              .pipe(
                Stream.map((stored) => ({
                  kind: "event" as const,
                  sequence: stored.sequence,
                  event: projectDomainEventForWire(stored.event),
                })),
                Stream.runCollect,
                Effect.map((items) => Array.from(items)),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              );

          const completionMarker =
            input.requestCompletionMarker === true
              ? Stream.make({ kind: "synchronized" as const })
              : Stream.empty;

          const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(
            function* () {
              const snapshotSequence = yield* applicationEvents.latestApplicationSequence.pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to prepare orchestration V2 thread ${input.threadId} snapshot`,
                      cause,
                    }),
                ),
              );
              const snapshot = yield* threadManagement.getThreadSnapshot(input.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to load orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              );
              const tree = yield* loadSubagentTree(snapshot.projection).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to load nested agents for orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              );
              const projection = projectThreadProjectionForWire(tree.projection);
              return Stream.concat(
                Stream.concat(
                  Stream.make({
                    kind: "snapshot" as const,
                    snapshotSequence,
                    projection,
                  }),
                  completionMarker,
                ),
                eventStreamFrom(snapshotSequence, tree.threadIds),
              );
            },
          );

          // When the client already holds the projection (cached, or loaded over
          // HTTP) it passes that snapshot's sequence, and we resume by replaying
          // persisted events after it instead of re-sending the (potentially
          // multi-KB) snapshot frame over the socket. The event sink subscribes
          // to live events before reading the persisted tail, so no event
          // published during the replay window is lost; overlapping events are
          // deduped by sequence on the client.
          if (input.afterSequence !== undefined) {
            const highWater = yield* applicationEvents.latestApplicationSequence.pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
                    cause,
                  }),
              ),
            );
            const currentProjection = yield* threadManagement
              .getThreadProjection(input.threadId)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to inspect nested agents for orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              );
            const currentTree = yield* loadSubagentTree(currentProjection).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to inspect nested agents for orchestration V2 thread ${input.threadId}`,
                    cause,
                  }),
              ),
            );
            if (currentTree.threadIds.size > 1) {
              return Stream.concat(
                Stream.concat(
                  Stream.make({
                    kind: "snapshot" as const,
                    snapshotSequence: highWater,
                    projection: projectThreadProjectionForWire(currentTree.projection),
                  }),
                  completionMarker,
                ),
                eventStreamFrom(highWater, currentTree.threadIds),
              );
            }
            const replay = yield* loadReplayThrough(input.afterSequence, highWater);
            const plan = decideThreadResume({
              afterSequence: input.afterSequence,
              highWater,
              replayEventCount: replay.length,
              replayEncodedBytes: threadReplayEncodedBytes(replay),
            });
            if (plan.mode === "snapshot") {
              return yield* snapshotThenLive();
            }
            return Stream.concat(
              Stream.concat(Stream.fromIterable(replay), completionMarker),
              eventStreamFrom(highWater, currentTree.threadIds),
            );
          }

          return yield* snapshotThenLive();
        },
      );

      const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
        function* (input: {
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: boolean;
        }) {
          const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
          const loadProjectMetadataSnapshot = Effect.fn(
            "ws.orchestrationV2.loadProjectMetadataSnapshot",
          )(function* (snapshotSequence: number) {
            const projects = yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment();
            const enriched = yield* enrichProjectShells(projects);
            return {
              snapshot: {
                schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
                snapshotSequence,
                projects: enriched.projects,
                threads: [],
                archivedThreads: [],
              } as OrchestrationV2ShellSnapshot,
              resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
            };
          });
          const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
            const base = yield* sql.withTransaction(
              Effect.gen(function* () {
                const projects = yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment();
                const threads = yield* threadManagement
                  .getShellSnapshot({ location: "active" })
                  .pipe(Effect.map(ThreadManagementService.userFacingShellSnapshot));
                return buildActiveShellSnapshot({
                  projects,
                  threads,
                  snapshotSequence: yield* applicationEvents.latestApplicationSequence,
                });
              }),
            );
            const enriched = yield* enrichProjectShells(base.projects);
            return {
              snapshot: { ...base, projects: enriched.projects } as OrchestrationV2ShellSnapshot,
              resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
            };
          });
          const projectItem = Effect.fn("ws.orchestrationV2.projectShellItem")(function* (
            stored: Extract<ApplicationStoredEvent, { readonly aggregateKind: "project" }>,
          ) {
            if (stored.type === "project.deleted") {
              return {
                kind: "project.removed" as const,
                sequence: stored.sequence,
                projectId: stored.payload.projectId,
              };
            }
            const project = yield* projectionSnapshotQuery.getProjectShellById(
              stored.payload.projectId,
            );
            return Option.match(project, {
              onNone: () => ({
                kind: "project.removed" as const,
                sequence: stored.sequence,
                projectId: stored.payload.projectId,
              }),
              onSome: (value) => ({
                kind: "project.updated" as const,
                sequence: stored.sequence,
                project: value,
              }),
            });
          });

          // Coalescing makes each per-thread shell read represent every event
          // for that thread in the current window; reading only the affected
          // threads keeps the cost of a busy stream independent of how many
          // threads exist overall.
          const projectShellItems = Effect.fn("ws.orchestrationV2.projectShellItems")(function* (
            events: ReadonlyArray<ApplicationStoredEvent>,
          ) {
            return yield* Effect.forEach(
              coalesceShellApplicationEvents(events),
              (stored) =>
                Effect.gen(function* () {
                  if ("aggregateKind" in stored) {
                    return yield* projectItem(stored);
                  }
                  const shell = yield* threadManagement.getThreadShell(stored.event.threadId);
                  // An internal subagent thread is not part of the user-facing
                  // stream; treating its shell as absent emits a removal the
                  // client reducer absorbs.
                  return shellStreamItemFromThreadShell({
                    stored,
                    shell:
                      shell !== null && ThreadManagementService.isInternalSubagentThread(shell)
                        ? null
                        : shell,
                  });
                }),
              { concurrency: 8 },
            );
          });

          const toShellStream = <E, R>(stream: Stream.Stream<ApplicationStoredEvent, E, R>) =>
            stream.pipe(
              Stream.groupedWithin(512, Duration.millis(50)),
              Stream.mapEffect((events) => projectShellItems(Array.from(events))),
              Stream.flatMap(Stream.fromIterable),
            );

          const liveFrom = (afterSequence: number) =>
            toShellStream(applicationEvents.streamApplicationEvents({ afterSequence }));

          const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
            Stream.filter((change) => change.repositoryIdentityResolved),
            Stream.groupedWithin(64, Duration.millis(25)),
            Stream.mapEffect((changes) =>
              applicationEvents.latestApplicationSequence.pipe(
                Effect.flatMap(loadProjectMetadataSnapshot),
                Effect.map(({ snapshot }) =>
                  shellStreamItemFromEnrichmentRefresh({
                    snapshot,
                    changes: Array.from(changes),
                  }),
                ),
              ),
            ),
          );

          // Always attach the enrichment subscription before the first load so
          // completions that race HTTP snapshot fetch still push a refresh.
          // When the client already holds a shell snapshot (cached, or loaded
          // over HTTP) it passes that snapshot's sequence. We still emit one
          // compact metadata refresh up front: getAvailable may have been cold on the
          // HTTP path (null identity), and enrichment PubSub events published
          // before this subscribe attached are dropped. Rehydrating here fills
          // repositoryIdentity for cross-environment project grouping even on
          // afterSequence resumes. Application events after the sequence still
          // stream as deltas; overlapping events are deduped by sequence on the
          // client.
          //
          // After the unmarked authoritative frame, emit a same-sequence
          // metadata-only frame for roots that already resolved successfully
          // (including cached null). Cold/failed roots stay unmarked and use
          // the PubSub enrichment path when they complete later.
          const completionMarker =
            input.requestCompletionMarker === true
              ? Stream.make({ kind: "synchronized" as const })
              : Stream.empty;
          const initialSnapshotItems = (loaded: {
            readonly snapshot: OrchestrationV2ShellSnapshot;
            readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
          }) =>
            Stream.fromIterable(
              shellStreamItemsFromInitialSnapshot({
                snapshot: loaded.snapshot,
                resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
              }),
            );
          const initialEnrichmentItems = (loaded: {
            readonly snapshot: OrchestrationV2ShellSnapshot;
            readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
          }) =>
            Stream.fromIterable(
              shellStreamItemsFromResumeSnapshot({
                snapshot: loaded.snapshot,
                resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
              }),
            );
          // Initial unmarked (+ optional same-load marked) always drains first.
          // Enrichment merges only with the post-prefix tail so a ready marked
          // refresh cannot interleave before the authoritative initial frame.
          const completionThenLive = (afterSequence: number) =>
            Stream.concat(completionMarker, liveFrom(afterSequence));

          const stream = yield* Effect.gen(function* () {
            if (input.afterSequence === undefined) {
              const loaded = yield* loadSnapshot();
              return composeShellStreamWithEnrichment({
                initial: initialSnapshotItems(loaded),
                tail: completionThenLive(loaded.snapshot.snapshotSequence),
                enrichment: enrichmentRefreshes,
              });
            }

            const highWater = yield* applicationEvents.latestApplicationSequence;
            const replayGap = highWater - input.afterSequence;
            if (replayGap < 0 || replayGap > SHELL_RESUME_MAX_GAP) {
              const loaded = yield* loadSnapshot();
              return composeShellStreamWithEnrichment({
                initial: initialSnapshotItems(loaded),
                tail: completionThenLive(loaded.snapshot.snapshotSequence),
                enrichment: enrichmentRefreshes,
              });
            }

            const loaded = yield* loadProjectMetadataSnapshot(highWater);
            const replay = toShellStream(
              applicationEvents.readApplicationEvents({
                afterSequence: input.afterSequence,
                throughSequence: highWater,
              }),
            );
            return composeShellStreamWithEnrichment({
              initial: initialEnrichmentItems(loaded),
              tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(highWater)),
              enrichment: enrichmentRefreshes,
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to prepare the application shell stream",
                  cause,
                }),
            ),
          );

          return stream.pipe(
            Stream.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed while streaming the application shell",
                  cause,
                }),
            ),
          );
        },
      );

      const getOrchestrationV2ArchivedShellSnapshot = sql
        .withTransaction(
          Effect.gen(function* () {
            const projects = yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment();
            const threads = yield* threadManagement
              .getShellSnapshot({ location: "archive" })
              .pipe(Effect.map(ThreadManagementService.userFacingShellSnapshot));
            return {
              schemaVersion: threads.schemaVersion,
              snapshotSequence: yield* applicationEvents.latestApplicationSequence,
              projects,
              threads: threads.archivedThreads,
            } as const;
          }),
        )
        .pipe(
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

      const subscribeOrchestrationV2ArchivedShell = Effect.fn(
        "ws.orchestrationV2.subscribeArchivedShell",
      )(function* () {
        const snapshot = yield* getOrchestrationV2ArchivedShellSnapshot;
        const live = threadManagement
          .streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence })
          .pipe(
            Stream.groupedWithin(512, Duration.millis(50)),
            Stream.mapEffect((events) =>
              Effect.forEach(
                coalesceStoredThreadEvents(Array.from(events)),
                (stored) =>
                  threadManagement.getThreadShell(stored.event.threadId).pipe(
                    Effect.map((shell) =>
                      archivedShellStreamItemFromThreadShell({
                        stored,
                        shell:
                          shell !== null && ThreadManagementService.isInternalSubagentThread(shell)
                            ? null
                            : shell,
                      }),
                    ),
                  ),
                { concurrency: 8 },
              ),
            ),
            Stream.flatMap(Stream.fromIterable),
            Stream.filterMap((item) => (item === null ? Result.failVoid : Result.succeed(item))),
            Stream.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed while streaming archived threads",
                  cause,
                }),
            ),
          );
        return Stream.concat(Stream.make({ kind: "snapshot" as const, snapshot }), live);
      });

      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        switch (mutation.type) {
          case "project.create":
            return yield* projectService.create({
              commandId: mutation.commandId,
              projectId: mutation.projectId,
              title: mutation.title,
              workspaceRoot: mutation.workspaceRoot,
              ...(mutation.createWorkspaceRootIfMissing === undefined
                ? {}
                : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
              ...(mutation.defaultModelSelection === undefined
                ? {}
                : { defaultModelSelection: mutation.defaultModelSelection }),
              ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
            });
          case "project.update":
            return yield* projectService.update({
              commandId: mutation.commandId,
              projectId: mutation.projectId,
              ...(mutation.title === undefined ? {} : { title: mutation.title }),
              ...(mutation.workspaceRoot === undefined
                ? {}
                : { workspaceRoot: mutation.workspaceRoot }),
              ...(mutation.defaultModelSelection === undefined
                ? {}
                : { defaultModelSelection: mutation.defaultModelSelection }),
              ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
            });
          case "project.delete": {
            const snapshot = yield* threadManagement.getShellSnapshot();
            const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
              (thread) => thread.projectId === mutation.projectId,
            );
            if (projectThreads.length > 0 && mutation.force !== true) {
              return yield* new ProjectMutationError({
                commandId: mutation.commandId,
                message: `Project ${mutation.projectId} is not empty.`,
              });
            }
            yield* Effect.forEach(
              projectThreads,
              (thread) =>
                threadManagement.dispatch({
                  type: "thread.delete",
                  commandId: CommandId.make(`${mutation.commandId}:delete-thread:${thread.id}`),
                  threadId: thread.id,
                }),
              { concurrency: 1, discard: true },
            );
            return yield* projectService.delete({
              commandId: mutation.commandId,
              projectId: mutation.projectId,
            });
          }
        }
      });

      const handlers = ServerWsRpcGroup.of({
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
            startup
              .enqueueCommand(
                threadManagement.dispatch(
                  ThreadManagementService.withCreationProvenance(command, {
                    createdBy: "user",
                    creationSource: "creationSource" in command ? command.creationSource : "web",
                  }),
                ),
              )
              .pipe(
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
            {
              "rpc.aggregate": "orchestrationV2",
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
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
            readWorkflowScript({ scriptPath: input.scriptPath }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
            getOrchestrationV2ArchivedShellSnapshot,
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.listAllThreadRefs]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.listAllThreadRefs,
            threadManagement.listAllThreadRefs().pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetShellSnapshotError({
                    message: "Failed to list orchestration V2 thread references",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestrationV2" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
            threadManagement.getThreadProjection(input.threadId).pipe(
              Effect.map(projectThreadProjectionForWire),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to load orchestration V2 thread ${input.threadId}`,
                    cause,
                  }),
              ),
            ),
            {
              "rpc.aggregate": "orchestrationV2",
              "orchestration_v2.thread_id": input.threadId,
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_V2_WS_METHODS.launchThread,
            startup
              .enqueueCommand(
                threadLaunch.launch({
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
                        },
                      }),
                  createdBy: "user",
                  creationSource: input.creationSource ?? "web",
                }),
              )
              .pipe(
                Effect.map((result) => ({
                  ...result,
                  projection: projectThreadProjectionForWire(result.projection),
                })),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: "Failed to launch thread",
                      cause,
                    }),
                ),
              ),
            {
              "rpc.aggregate": "orchestration",
              "orchestration_v2.command_id": input.commandId,
              "orchestration_v2.project_id": input.projectId,
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
            subscribeOrchestrationV2ArchivedShell(),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_V2_WS_METHODS.subscribeShell,
            subscribeOrchestrationV2Shell(input),
            {
              "rpc.aggregate": "orchestrationV2",
            },
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_V2_WS_METHODS.subscribeThread,
            subscribeOrchestrationV2Thread(input),
            {
              "rpc.aggregate": "orchestrationV2",
              "orchestration_v2.thread_id": input.threadId,
            },
          ),
        [WS_METHODS.scheduledTasksList]: (_input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksList, scheduledTasks.list(), {
            "rpc.aggregate": "scheduledTasks",
          }),
        [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
          observeRpcStream(WS_METHODS.scheduledTasksSubscribe, scheduledTasks.subscribeList(), {
            "rpc.aggregate": "scheduledTasks",
          }),
        [WS_METHODS.scheduledTasksUpsert]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksUpsert, scheduledTasks.upsert(input), {
            "rpc.aggregate": "scheduledTasks",
          }),
        [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksSetEnabled, scheduledTasks.setEnabled(input), {
            "rpc.aggregate": "scheduledTasks",
            "scheduled_task.id": input.id,
          }),
        [WS_METHODS.scheduledTasksDelete]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksDelete, scheduledTasks.delete(input), {
            "rpc.aggregate": "scheduledTasks",
            "scheduled_task.id": input.id,
          }),
        [WS_METHODS.scheduledTasksRunNow]: (input) =>
          observeRpcEffect(WS_METHODS.scheduledTasksRunNow, scheduledTasks.runNow(input), {
            "rpc.aggregate": "scheduledTasks",
            "scheduled_task.id": input.id,
          }),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverSelfUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverSelfUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetUsageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.serverGetUsageSummary, usage.readSummary(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsListStats]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsListStats, pullRequests.listStats(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsDetail, pullRequests.detail(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsActivity, pullRequests.activity(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsThreadComments,
            pullRequests.threadComments(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDiffFileContents,
            pullRequests.diffFileContents(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsRunAction, pullRequests.runAction(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsUpdate, pullRequests.update(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsComment, pullRequests.comment(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdateComment,
            pullRequests.updateComment(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSubmitReview, pullRequests.submitReview(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            pullRequests.replyToThread(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            pullRequests.setThreadResolution(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSetReaction, pullRequests.setReaction(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsInvalidate, pullRequests.invalidate(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            pullRequests.reviewerCandidates(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            pullRequests.requestReviewers(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsMutate]: (mutation) =>
          observeRpcEffect(
            WS_METHODS.projectsMutate,
            startup.enqueueCommand(mutateProject(mutation)).pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProjectMutationError"
                  ? cause
                  : new ProjectMutationError({
                      commandId: mutation.commandId,
                      message: "Failed to mutate project.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (input.resource._tag === "attachment") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource._tag === "project-favicon") {
                const project = yield* projectionSnapshotQuery
                  .getActiveProjectByWorkspaceRoot(input.resource.cwd)
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
                return yield* issueAssetUrl({
                  resource: input.resource,
                  ...(project.value.faviconPath
                    ? { projectFaviconPath: project.value.faviconPath }
                    : {}),
                });
              }
              const thread = yield* threadManagement
                .getThreadProjection(input.resource.threadId)
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
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsPersistChatAttachments]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsPersistChatAttachments,
            persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
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
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.reviewGetDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffFileContents,
            review.getDiffFileContents(input),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
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
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
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
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
      return handlers;
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(ServerWsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session, previewAutomationBroker).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
