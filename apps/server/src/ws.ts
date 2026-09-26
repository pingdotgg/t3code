import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Result,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  type AuthAccessStreamEvent,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  AuthSessionId,
  CommandId,
  type DiscoveredLocalServer,
  type DiscoveredLocalServerList,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  GitHubCliError,
  PullRequestUnavailableError,
  PullRequestMonitorError,
  CollaborativeAcceptanceCaseLookupError,
  CollaborativeAcceptanceError,
  RpcClientId,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffStateError,
  OrchestrationGetSnapshotError,
  OrchestrationGetThreadActivitiesError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffStateError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  MessageId,
  ProjectId,
  ServerChatArchiveError,
  ServerProviderListCommandsError,
  ServerExportThreadMarkdownError,
  ThreadId,
  TurnId,
  type TerminalEvent,
  type TerminalError,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type VcsError,
  VcsUnsupportedOperationError,
  WorkflowRunError,
  type WorkflowRunInput,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
  type PullRequestRef,
  WorkflowRunId,
  WorkflowArtifactId,
  WorkflowNodeId,
  SourceControlRepositoryError,
  ServerProviderUpdateError,
  KeybindingsConfigError,
  type RelayClientInstallProgressEvent,
  RelayClientInstallFailedError,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as RelayClient from "@t3tools/shared/relayClient";
import { REVIEW_CHANGES_WORKFLOW_ID } from "@t3tools/shared/workflows/reviewChanges";
import {
  buildFixReviewIssuesPrompt,
  FIX_REVIEW_ISSUES_WORKFLOW_ID,
} from "@t3tools/shared/workflows/fixReviewIssues";
import {
  gitCheckoutResultToVcs,
  gitCommandErrorToVcs,
  gitCreateBranchResultToVcs,
  gitCreateWorktreeResultToVcs,
  gitListBranchesToVcs,
  gitPullResultToVcs,
  gitStatusStreamEventToVcs,
  gitStatusToVcs,
  vcsCreateRefInputToGit,
  vcsCreateWorktreeInputToGit,
  vcsListRefsInputToGit,
} from "./git/VcsBridge.ts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { DiffStateQuery } from "./diffState/Services/DiffStateQuery.ts";
import { ServerConfig } from "./config.ts";
import { loadAuthAccessSnapshot } from "./auth/authAccessSnapshot.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { CheckoutCoordinator } from "./git/CheckoutCoordinator.ts";
import { GitHubCli } from "./git/Services/GitHubCli.ts";
import { GitManager } from "./git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster.ts";
import { Keybindings } from "./keybindings.ts";
import { Open, resolveAvailableEditors } from "./open.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { makeClientCommandDispatcher } from "./orchestration/clientCommandDispatcher.ts";
import { crossVersionRpcSerializationLayer } from "./rpc/crossVersionRpcSerialization.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowCoordinatorReactor } from "./orchestration/Services/WorkflowCoordinatorReactor.ts";
import { runReviewChangesWorkflow } from "./orchestration/reviewChangesWorkflow.ts";
import {
  filterArchivedShellSnapshot,
  filterActiveShellSnapshot,
  toShellStreamEvent as projectShellStreamEvent,
} from "./orchestration/shellStream.ts";
import { isThreadDetailEvent } from "./orchestration/threadDetailEvents.ts";
import { collectActiveThreadSubtree } from "./orchestration/threadHierarchy.ts";
import {
  createChatArchiveManifest,
  importedMessageText,
  readChatArchive,
  writeChatArchive,
} from "./orchestration/chatArchive.ts";
import {
  createThreadMarkdownExportFilename,
  formatThreadMarkdownExport,
} from "./orchestration/threadMarkdownExport.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { withLogContext } from "./observability/LogContext.ts";
import { outcomeFromExit } from "./observability/Attributes.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { listCopilotPreconnectionCommands } from "./provider/copilotPreconnectionCommands.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { SidebarState } from "./sidebarState.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { listServerSkills } from "./skills/skillCatalog.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { ServerAuth, type AuthenticatedSession } from "./auth/Services/ServerAuth.ts";
import { rpcAuthorizationLayer } from "./auth/RpcAuthorization.ts";
import { PreviewManager } from "./preview/Manager.ts";
import { PortDiscovery } from "./preview/PortScanner.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { PreviewAutomationBroker } from "./mcp/PreviewAutomationBroker.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import { expandHomePath } from "./pathExpansion.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { repositoryFromPullRequestUrl } from "./pullRequestMonitor/PullRequestMonitorAssociationReactor.ts";
import * as PullRequestMonitors from "./pullRequestMonitor/PullRequestMonitorService.ts";
import { CollaborativeAcceptanceCoordinator } from "./collaborativeAcceptance/Coordinator.ts";
import { acceptanceAuthorityForThread } from "./collaborativeAcceptance/authority.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isWorkspacePathOutsideRootError = Schema.is(WorkspacePathOutsideRootError);
const isOrchestrationGetSnapshotError = Schema.is(OrchestrationGetSnapshotError);
const isProjectSearchEntriesError = Schema.is(ProjectSearchEntriesError);
const isProjectReadFileError = Schema.is(ProjectReadFileError);

async function writeThreadMarkdownExportFile(input: {
  readonly directory: string;
  readonly filename: string;
  readonly contents: string;
}): Promise<string> {
  const directoryPath = NodePath.resolve(expandHomePath(input.directory));
  const targetPath = NodePath.join(directoryPath, input.filename);
  const tempPath = NodePath.join(directoryPath, `.${input.filename}.${crypto.randomUUID()}.tmp`);

  await mkdir(directoryPath, { recursive: true });
  try {
    await writeFile(tempPath, input.contents, "utf8");
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return targetPath;
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;
const SHELL_RESUME_MAX_GAP = 1_000;
const THREAD_RESUME_MAX_GAP = 1_000;

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
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

let nextBackgroundConnectionGeneration = 0n;
const RPC_CLIENT_ID_MODULUS = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

function allocateBackgroundConnectionIdentity(): BackgroundPolicy.BackgroundConnectionIdentity {
  const generation = nextBackgroundConnectionGeneration;
  nextBackgroundConnectionGeneration += 1n;
  return {
    generation,
    rpcClientId: RpcClientId.make(Number(generation % RPC_CLIENT_ID_MODULUS)),
  };
}

const makeWsRpcLayer = (
  currentSession: AuthenticatedSession,
  backgroundConnection: BackgroundPolicy.BackgroundConnectionIdentity,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const deviceHostContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const diffStateQuery = yield* DiffStateQuery;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const gitManager = yield* GitManager;
      const git = yield* GitCore;
      const checkoutCoordinator = yield* CheckoutCoordinator;
      const gitHubCli = yield* Effect.serviceOption(GitHubCli);
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      // Optional so the ws layer stays buildable without the provider runtime;
      // prewarming is a best-effort hint.
      const providerService = yield* Effect.serviceOption(ProviderService);
      // Optional so partial server builds/tests without cloud runtime still construct.
      const relayClient = yield* Effect.serviceOption(RelayClient.RelayClient);
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const sidebarState = yield* SidebarState;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const previewManager = yield* PreviewManager;
      const portDiscovery = yield* PortDiscovery;
      const deviceService = yield* DeviceService.DeviceService;
      const previewAutomationBroker = yield* PreviewAutomationBroker;
      const pullRequests = yield* Effect.serviceOption(PullRequestService.PullRequestService);
      const pullRequestMonitors = yield* Effect.serviceOption(
        PullRequestMonitors.PullRequestMonitorService,
      );
      const acceptanceCoordinator = yield* Effect.serviceOption(CollaborativeAcceptanceCoordinator);
      const withAcceptance = <A>(
        operation: (
          service: CollaborativeAcceptanceCoordinator["Service"],
        ) => Effect.Effect<A, CollaborativeAcceptanceError>,
      ): Effect.Effect<A, CollaborativeAcceptanceError> =>
        Option.match(acceptanceCoordinator, {
          onNone: () =>
            Effect.fail(
              new CollaborativeAcceptanceError({
                message: "Collaborative acceptance is unavailable in this environment.",
              }),
            ),
          onSome: operation,
        });
      const resolveAcceptanceThread = (threadId: ThreadId) =>
        projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
          Effect.mapError(
            () =>
              new CollaborativeAcceptanceError({
                message: "Could not resolve the acceptance thread.",
              }),
          ),
          Effect.flatMap((thread) =>
            Option.isSome(thread)
              ? Effect.succeed(thread.value)
              : Effect.fail(
                  new CollaborativeAcceptanceError({
                    message: "Acceptance thread is unavailable.",
                    reason: "participant-unavailable",
                  }),
                ),
          ),
        );
      const withAcceptanceLookup = <A>(
        operation: (
          service: CollaborativeAcceptanceCoordinator["Service"],
        ) => Effect.Effect<A, CollaborativeAcceptanceCaseLookupError>,
      ): Effect.Effect<A, CollaborativeAcceptanceCaseLookupError> =>
        Option.match(acceptanceCoordinator, {
          onNone: () =>
            Effect.fail(
              new CollaborativeAcceptanceCaseLookupError({
                message: "Collaborative acceptance is unavailable in this environment.",
                reason: "unavailable",
              }),
            ),
          onSome: operation,
        });
      const hasDurablePullRequestAssociation = (
        thread: OrchestrationThread,
        pullRequest: PullRequestRef,
      ): boolean =>
        thread.projectId === pullRequest.projectId &&
        [
          ...(thread.pullRequest === undefined || thread.pullRequest === null
            ? []
            : [thread.pullRequest]),
          ...(thread.linkedPullRequest === undefined || thread.linkedPullRequest === null
            ? []
            : [thread.linkedPullRequest]),
          ...(thread.branchPullRequest === undefined || thread.branchPullRequest === null
            ? []
            : [thread.branchPullRequest]),
          ...(thread.pullRequests ?? []).map((link) => link.pullRequest),
        ].some(
          (association) =>
            association.number === pullRequest.number &&
            repositoryFromPullRequestUrl(association.url) === pullRequest.repository,
        );
      const withPullRequestMonitors = <A, E>(
        f: (
          service: PullRequestMonitors.PullRequestMonitorService["Service"],
        ) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | PullRequestMonitorError> =>
        Option.match(pullRequestMonitors, {
          onNone: () =>
            Effect.fail(
              new PullRequestMonitorError({
                message: "Pull request monitoring is unavailable in this environment.",
              }),
            ),
          onSome: f,
        });
      const withPullRequests = <A, E>(
        operation: (
          service: PullRequestService.PullRequestService["Service"],
        ) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | PullRequestUnavailableError> =>
        Option.match(pullRequests, {
          onNone: () =>
            Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
          onSome: operation,
        });
      const dispatchNormalizedCommand = makeClientCommandDispatcher({
        orchestrationEngine,
        startup,
        git,
        gitStatusBroadcaster,
        projectSetupScriptRunner,
      });

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                (yield* orchestrationEngine.getReadModel()).projects.find(
                  (project) => project.id === event.payload.projectId,
                )?.workspaceRoot ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            });
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        if (event.aggregateKind === "workflow") {
          return Effect.succeed(
            Option.some({
              kind: "workflow-event" as const,
              sequence: event.sequence,
              event,
            }),
          );
        }
        return projectShellStreamEvent(projectionSnapshotQuery, event);
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
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
          availableEditors: resolveAvailableEditors(),
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
        };
      });

      const refreshGitStatus = (cwd: string) =>
        gitStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const workflowSkipped = (
        input: Pick<WorkflowRunInput, "idempotencyKey">,
        reason: Extract<WorkflowRunResult, { status: "skipped" }>["reason"],
        message: string,
      ): WorkflowRunResult => ({
        status: "skipped" as const,
        runId: WorkflowRunId.make(input.idempotencyKey),
        reason,
        message,
        createdAt: new Date().toISOString(),
      });

      const dispatchSingleNodeWorkflow = (input: {
        readonly request: WorkflowRunInput;
        readonly runId: WorkflowRunId;
        readonly workflowId: string;
        readonly title: string;
        readonly prompt: string;
        readonly nodeId: WorkflowNodeId;
        readonly workerConfig: WorkflowWorkerConfig;
        readonly createdAt: string;
      }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`workflow:${input.runId}:node:${input.nodeId}:worker`);
          const commandId = CommandId.make(`workflow:${input.runId}:request`);
          const messageId = MessageId.make(`workflow:${input.runId}:node:${input.nodeId}:input`);
          const dispatchResult = yield* orchestrationEngine.dispatch({
            type: "workflow.run.request",
            commandId,
            runId: input.runId,
            parentThreadId: input.request.threadId,
            definition: {
              id: input.workflowId,
              name: input.title,
              nodes: [
                {
                  id: input.nodeId,
                  title: input.title,
                  prompt: input.prompt,
                  contextPolicy: "none",
                },
              ],
            },
            workerConfig: input.workerConfig,
            inputArtifact: {
              id: WorkflowArtifactId.make(`workflow:${input.runId}:input`),
              runId: input.runId,
              nodeId: input.nodeId,
              producerThreadId: input.request.threadId,
              payload: {
                kind: "input-context",
                contextPolicy: "none",
                parentThreadId: input.request.threadId,
                messages: [],
                truncated: false,
              },
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          });
          // Drive the coordinator inline so the worker thread and its first turn
          // exist by the time this call resolves; otherwise the client polls for
          // a thread that only appears after the event-stream reconciliation hop.
          const coordinator = yield* Effect.serviceOption(WorkflowCoordinatorReactor);
          if (Option.isSome(coordinator)) {
            yield* coordinator.value.drainRun(input.runId);
          }
          return {
            status: "started" as const,
            runId: input.runId,
            threadId,
            commandId,
            messageId,
            sequence: dispatchResult.sequence,
            createdAt: input.createdAt,
          } satisfies WorkflowRunResult;
        });

      const runWorkflow = (input: WorkflowRunInput) =>
        Effect.gen(function* () {
          if (input.workflowId === REVIEW_CHANGES_WORKFLOW_ID) {
            return yield* runReviewChangesWorkflow(
              {
                git,
                orchestrationEngine,
                projectionSnapshotQuery,
                serverSettings,
                workflowCoordinator: yield* Effect.serviceOption(WorkflowCoordinatorReactor),
              },
              input,
            );
          }
          const runId = WorkflowRunId.make(input.idempotencyKey);
          const createdAt = new Date().toISOString();
          const settings = yield* serverSettings.getSettings;
          const isBuiltInWorkflow = input.workflowId === FIX_REVIEW_ISSUES_WORKFLOW_ID;
          const customWorkflow = isBuiltInWorkflow
            ? undefined
            : settings.agentWorkflows.customWorkflows.find(
                (candidate) => candidate.id === input.workflowId,
              );

          if (!isBuiltInWorkflow && customWorkflow === undefined) {
            return workflowSkipped(input, "workflow-not-found", "Workflow not found.");
          }
          if (
            customWorkflow === undefined &&
            input.destinationMode !== undefined &&
            input.destinationMode !== "child-chat"
          ) {
            return yield* new WorkflowRunError({
              message: "Built-in workflows currently support only child-chat destinations.",
            });
          }

          const fixSettings = settings.agentWorkflows.fixReviewIssues;
          const override = settings.agentWorkflows.builtInOverrides[input.workflowId];
          if (customWorkflow !== undefined && !customWorkflow.enabled) {
            return workflowSkipped(input, "workflow-disabled", "Workflow is disabled.");
          }
          if (customWorkflow === undefined) {
            const enabled = override?.enabled ?? fixSettings.enabled;
            if (!enabled) {
              return workflowSkipped(
                input,
                "workflow-disabled",
                "Fix Review Issues workflow is disabled.",
              );
            }
          }

          const threadOption = yield* projectionSnapshotQuery.getThreadShellById(input.threadId);
          if (Option.isNone(threadOption)) {
            return workflowSkipped(input, "thread-not-found", "Thread not found.");
          }
          const thread = threadOption.value;

          const projectId = input.projectId ?? thread.projectId;
          const projectOption = yield* projectionSnapshotQuery.getProjectShellById(projectId);
          if (Option.isNone(projectOption)) {
            return workflowSkipped(input, "project-not-found", "Project not found.");
          }
          const project = projectOption.value;
          const cwd = input.cwd ?? thread.worktreePath ?? project.workspaceRoot;

          if (customWorkflow !== undefined) {
            const prompt = customWorkflow.promptTemplate.trim();
            if (prompt.length === 0) {
              return yield* new WorkflowRunError({
                message: "Custom workflow prompt cannot be empty.",
              });
            }
            const destinationMode = input.destinationMode ?? customWorkflow.destinationMode;
            const threadId =
              destinationMode === "same-chat"
                ? input.threadId
                : ThreadId.make(`workflow:${runId}:target`);
            const commandId = CommandId.make(`workflow:${runId}:request`);
            const messageId = MessageId.make(`workflow:${runId}:input`);
            const modelSelection =
              customWorkflow.modelSelection ??
              input.modelSelection ??
              project.defaultModelSelection ??
              thread.modelSelection;
            const runtimeMode = input.runtimeMode ?? thread.runtimeMode;
            const interactionMode = input.interactionMode ?? thread.interactionMode;
            if (destinationMode !== "same-chat") {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`workflow:${runId}:create-target`),
                threadId,
                projectId: project.id,
                parentThreadId: destinationMode === "child-chat" ? input.threadId : null,
                title: input.title ?? customWorkflow.name,
                modelSelection,
                runtimeMode,
                interactionMode,
                branch: thread.branch,
                worktreePath: cwd === project.workspaceRoot ? null : cwd,
                createdAt,
              });
            }
            const dispatchResult = yield* orchestrationEngine.dispatch({
              type: "thread.turn.start",
              commandId,
              threadId,
              message: {
                messageId,
                role: "user",
                text: prompt,
                attachments: [],
              },
              modelSelection,
              titleSeed: input.title ?? customWorkflow.name,
              runtimeMode,
              interactionMode,
              createdAt,
            });
            return {
              status: "started" as const,
              runId,
              threadId,
              commandId,
              messageId,
              sequence: dispatchResult.sequence,
              createdAt,
            } satisfies WorkflowRunResult;
          }

          if (input.workflowId === FIX_REVIEW_ISSUES_WORKFLOW_ID) {
            const issues = typeof input.input?.issues === "string" ? input.input.issues.trim() : "";
            if (issues.length === 0) {
              return yield* new WorkflowRunError({
                message: "Fix Review Issues requires at least one review issue.",
              });
            }

            const title = input.title ?? "Fix review issues";
            const nodeId = WorkflowNodeId.make(FIX_REVIEW_ISSUES_WORKFLOW_ID);
            const threadDetailOption = yield* projectionSnapshotQuery.getThreadDetailById(
              input.threadId,
            );
            const reviewScope = Option.isSome(threadDetailOption)
              ? threadDetailOption.value.reviewResult?.snapshot.scope
              : undefined;
            const workerWorkspace =
              reviewScope?.kind === "pull-request"
                ? yield* gitManager.preparePullRequestThread({
                    cwd: project.workspaceRoot,
                    reference: reviewScope.url,
                    mode: "worktree",
                    threadId: ThreadId.make(`workflow:${runId}:node:${nodeId}:worker`),
                  })
                : {
                    branch: thread.branch,
                    worktreePath: cwd === project.workspaceRoot ? null : cwd,
                  };
            return yield* dispatchSingleNodeWorkflow({
              request: input,
              runId,
              workflowId: FIX_REVIEW_ISSUES_WORKFLOW_ID,
              title,
              prompt: buildFixReviewIssuesPrompt({
                issues,
                ...(reviewScope?.kind === "pull-request"
                  ? { pullRequestNumber: reviewScope.number }
                  : {}),
                settings: {
                  promptTemplate: override?.promptTemplate ?? fixSettings.promptTemplate,
                },
              }),
              nodeId,
              workerConfig: {
                modelSelection:
                  fixSettings.modelSelection ??
                  input.modelSelection ??
                  project.defaultModelSelection ??
                  thread.modelSelection,
                runtimeMode: input.runtimeMode ?? thread.runtimeMode,
                interactionMode: input.interactionMode ?? thread.interactionMode,
                branch: workerWorkspace.branch,
                worktreePath: workerWorkspace.worktreePath,
                ...("pullRequest" in workerWorkspace
                  ? { pullRequest: workerWorkspace.pullRequest }
                  : {}),
              },
              createdAt,
            });
          }

          return yield* new WorkflowRunError({
            message: `Unsupported built-in workflow '${input.workflowId}'.`,
          });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowRunError({
                message: cause instanceof Error ? cause.message : "Failed to run workflow.",
                cause,
              }),
          ),
        );

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const correlation = {
                commandId: command.commandId,
                commandType: command.type,
                authSessionId: currentSessionId,
                ...("threadId" in command ? { threadId: command.threadId } : {}),
              };
              yield* Effect.logInfo("client command received", correlation);
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const threadsToArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* Effect.gen(function* () {
                      const rootShell = yield* projectionSnapshotQuery
                        .getThreadShellById(normalizedCommand.threadId)
                        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
                      const subtree = collectActiveThreadSubtree(
                        yield* orchestrationEngine.getReadModel(),
                        normalizedCommand.threadId,
                      );
                      const rootFromReadModel = subtree.find(
                        (thread) => thread.id === normalizedCommand.threadId,
                      );
                      return [
                        {
                          id: normalizedCommand.threadId,
                          session: Option.match(rootShell, {
                            onNone: () => rootFromReadModel?.session ?? null,
                            onSome: (thread) => thread.session,
                          }),
                        },
                        ...subtree.flatMap((thread) =>
                          thread.id === normalizedCommand.threadId
                            ? []
                            : [{ id: thread.id, session: thread.session }],
                        ),
                      ];
                    })
                  : [];
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              yield* Effect.logInfo("client command committed", {
                ...correlation,
                sequence: result.sequence,
              });
              if (normalizedCommand.type === "thread.archive") {
                yield* Effect.forEach(
                  threadsToArchive,
                  (thread) =>
                    Effect.gen(function* () {
                      if (thread.session !== null && thread.session.status !== "stopped") {
                        yield* Effect.gen(function* () {
                          const stopCommand = yield* normalizeDispatchCommand({
                            type: "thread.session.stop",
                            commandId: CommandId.make(
                              `session-stop-for-archive:${normalizedCommand.commandId}:${thread.id}`,
                            ),
                            threadId: thread.id,
                            createdAt: new Date().toISOString(),
                          });
                          yield* dispatchNormalizedCommand(stopCommand);
                        }).pipe(
                          Effect.catchCause((cause) =>
                            Effect.logWarning("failed to stop provider session during archive", {
                              threadId: thread.id,
                              cause,
                            }),
                          ),
                        );
                      }

                      yield* terminalManager.close({ threadId: thread.id }).pipe(
                        Effect.catch((error) =>
                          Effect.logWarning("failed to close thread terminals after archive", {
                            threadId: thread.id,
                            error: error.message,
                          }),
                        ),
                      );
                    }),
                  { concurrency: 4 },
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
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
        [ORCHESTRATION_WS_METHODS.getThreadActivities]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getThreadActivities,
            projectionSnapshotQuery.getThreadActivitiesPage(input).pipe(
              Effect.map((page) => ({
                ...page,
                activities: page.activities.map(projectActivityPayload),
              })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetThreadActivitiesError({
                    message: "Failed to load older thread activity",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
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
        [ORCHESTRATION_WS_METHODS.getTurnDiffState]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiffState,
            diffStateQuery.getTurnDiffState(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffStateError({
                    message: "Failed to load turn diff state",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiffState]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiffState,
            diffStateQuery.getFullThreadDiffState(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffStateError({
                    message: "Failed to load full thread diff state",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.map((events) => events.map(projectActivityEvent)),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getShellSnapshot,
            projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchTranscript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchTranscript,
            (
              projectionSnapshotQuery.searchTranscript?.(input.query) ??
              Effect.succeed({ matches: [] })
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to search conversation transcripts",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            (
              projectionSnapshotQuery.searchTranscript?.(input.query) ??
              Effect.succeed({ matches: [] })
            ).pipe(
              Effect.flatMap((result) => {
                const matches = result.matches.slice(0, input.limit ?? 50);
                if (matches.length === 0) {
                  return Effect.succeed({ matches: [] });
                }
                // Narrow project lookup: search results need only the owning
                // project id per match. Hydrating full thread details here
                // cost ~9 heavy queries per match (messages, activities,
                // plans, turns) decoding payloads the caller discards.
                return projectionSnapshotQuery
                  .listThreadProjectIds(matches.map((match) => match.threadId))
                  .pipe(
                    Effect.map((projectIds) => ({
                      matches: matches.flatMap((match) => {
                        const projectId = projectIds.get(match.threadId);
                        return projectId === undefined
                          ? []
                          : [
                              {
                                threadId: match.threadId,
                                projectId,
                                source: match.role,
                                snippet: match.excerpt.slice(0, 240),
                                messageCreatedAt: match.updatedAt,
                              },
                            ];
                      }),
                    })),
                  );
              }),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to search conversation threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.readThread]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.readThread,
            projectionSnapshotQuery.readThread(input),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getThreadSnapshot]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getThreadSnapshot,
            projectionSnapshotQuery.getThreadDetailSnapshotById(input.threadId).pipe(
              Effect.flatMap((snapshot) => {
                if (Option.isNone(snapshot)) {
                  return new OrchestrationGetSnapshotError({
                    message: `Thread ${input.threadId} was not found`,
                    cause: input.threadId,
                  });
                }
                return Effect.succeed(snapshot.value).pipe(Effect.map(projectThreadDetailSnapshot));
              }),
              Effect.mapError((cause) =>
                isOrchestrationGetSnapshotError(cause)
                  ? cause
                  : new OrchestrationGetSnapshotError({
                      message: `Failed to load thread ${input.threadId}`,
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              // Attach live delivery before loading the snapshot so newly created
              // workflow threads cannot disappear during startup or reconnect.
              const liveBuffer = yield* Queue.unbounded<OrchestrationShellStreamItem>();
              yield* Effect.forkScoped(
                liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
              );

              const bufferedLiveStream = Stream.fromQueue(liveBuffer);
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        Queue.offer(liveBuffer, { kind: "synchronized" as const }),
                      ).pipe(Stream.drain),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = (yield* orchestrationEngine.getReadModel()).snapshotSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= SHELL_RESUME_MAX_GAP) {
                  const catchUpStream = orchestrationEngine.readEvents(afterSequence).pipe(
                    Stream.take(replayGap),
                    Stream.mapEffect(toShellStreamEvent),
                    Stream.flatMap((event) =>
                      Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                    ),
                    Stream.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: "Failed to replay orchestration shell events",
                          cause,
                        }),
                    ),
                  );
                  const liveAfterHead = bufferedLiveStream.pipe(
                    Stream.filter(
                      (item) =>
                        item.kind !== "snapshot" &&
                        item.kind !== "synchronized" &&
                        item.sequence > headSequence,
                    ),
                  );
                  return Stream.concat(
                    catchUpStream,
                    input.requestCompletionMarker === true
                      ? Stream.concat(
                          Stream.make({
                            kind: "synchronized" as const,
                            sequence: headSequence,
                          }),
                          liveAfterHead,
                        )
                      : liveAfterHead,
                  );
                }
              }

              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.map(filterActiveShellSnapshot),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive.pipe(
                  Stream.filter(
                    (item) =>
                      item.kind === "synchronized" ||
                      (item.kind !== "snapshot" && item.sequence > snapshot.snapshotSequence),
                  ),
                ),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event),
                ),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event),
                })),
              );

              // Attach live delivery before loading the snapshot so events emitted during the read
              // are buffered rather than permanently lost.
              const liveBuffer = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
              yield* Effect.forkScoped(
                liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
              );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer);

              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = (yield* orchestrationEngine.getReadModel()).snapshotSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= THREAD_RESUME_MAX_GAP) {
                  const catchUpStream = orchestrationEngine.readEvents(afterSequence).pipe(
                    Stream.take(replayGap),
                    Stream.filter(
                      (event) =>
                        event.aggregateKind === "thread" &&
                        event.aggregateId === input.threadId &&
                        isThreadDetailEvent(event),
                    ),
                    Stream.map((event) => ({
                      kind: "event" as const,
                      event: projectActivityEvent(event),
                    })),
                    Stream.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: `Failed to replay thread ${input.threadId} events`,
                          cause,
                        }),
                    ),
                  );
                  const liveAfterHead = bufferedLiveStream.pipe(
                    Stream.filter(
                      (item) => item.kind === "event" && item.event.sequence > headSequence,
                    ),
                  );
                  return Stream.concat(
                    catchUpStream,
                    input.requestCompletionMarker === true
                      ? Stream.concat(
                          Stream.make({
                            kind: "synchronized" as const,
                            sequence: headSequence,
                          }),
                          liveAfterHead,
                        )
                      : liveAfterHead,
                  );
                }
              }

              const threadSnapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshotById(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(threadSnapshot)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }
              const { snapshotSequence, thread } = threadSnapshot.value;
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        Queue.offer(liveBuffer, { kind: "synchronized" as const }),
                      ).pipe(Stream.drain),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot({
                    snapshotSequence,
                    thread,
                  }),
                }),
                synchronizedThenLive.pipe(
                  Stream.filter(
                    (item) =>
                      item.kind === "synchronized" ||
                      (item.kind === "event" && item.event.sequence > snapshotSequence),
                  ),
                ),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
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
            (input.instanceId !== undefined && input.cwd !== undefined
              ? providerRegistry.refreshWorkspaceSnapshot({
                  instanceId: input.instanceId,
                  cwd: input.cwd,
                })
              : input.instanceId !== undefined
                ? providerRegistry.refreshInstance(input.instanceId)
                : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverListProviderCommands]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverListProviderCommands,
            (input.provider === "copilot"
              ? Effect.tryPromise({
                  try: () => listCopilotPreconnectionCommands({ cwd: input.cwd }),
                  catch: (cause) =>
                    new ServerProviderListCommandsError({
                      message: "Failed to list provider commands",
                      cause,
                    }),
                })
              : Effect.succeed([])
            ).pipe(Effect.map((commands) => ({ commands }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverPrewarmProviderSession]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverPrewarmProviderSession,
            Option.match(providerService, {
              onNone: () => Effect.void,
              onSome: (service) =>
                service.prewarmSession({
                  instanceId: input.instanceId,
                  cwd: input.cwd,
                  runtimeMode: input.runtimeMode,
                }),
            }).pipe(Effect.as({})),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverListSkills]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverListSkills,
            Effect.promise(() => listServerSkills()),
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
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            Effect.gen(function* () {
              const deviceHosts = patch.deviceHosts
                ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(
                    Effect.provide(deviceHostContext),
                  )
                : undefined;
              const settings = yield* serverSettings.updateSettings({
                ...patch,
                ...(deviceHosts ? { deviceHosts } : {}),
              });
              return redactServerSettingsForClient(settings);
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.sidebarGetState]: (_input) =>
          observeRpcEffect(WS_METHODS.sidebarGetState, sidebarState.get, {
            "rpc.aggregate": "sidebar",
          }),
        [WS_METHODS.sidebarUpdateState]: (input) =>
          observeRpcEffect(WS_METHODS.sidebarUpdateState, sidebarState.update(input), {
            "rpc.aggregate": "sidebar",
          }),
        [WS_METHODS.serverExportActiveChats]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverExportActiveChats,
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings.pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerChatArchiveError({
                      message: cause.message,
                      cause,
                    }),
                ),
              );
              const exportDirectory = settings.chatExportDirectory.trim();
              if (exportDirectory.length === 0) {
                return yield* new ServerChatArchiveError({
                  message: "Set a chat export directory in Settings before exporting.",
                });
              }
              const threads = yield* projectionSnapshotQuery.getActiveChatArchiveEntries().pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerChatArchiveError({
                      message: "Unable to load active chats for export.",
                      cause,
                    }),
                ),
              );
              if (threads.length === 0) {
                return yield* new ServerChatArchiveError({
                  message: "There are no active chats to export.",
                });
              }
              const manifest = createChatArchiveManifest({
                threads,
                exportedAt: new Date(),
              });
              const path = yield* Effect.tryPromise({
                try: () => writeChatArchive(exportDirectory, manifest),
                catch: (cause) =>
                  new ServerChatArchiveError({
                    message: "Unable to write the chat archive.",
                    cause,
                  }),
              });
              return { path, threadCount: threads.length };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverImportChatArchive]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverImportChatArchive,
            Effect.gen(function* () {
              const manifest = yield* Effect.tryPromise({
                try: () => readChatArchive(input.path),
                catch: (cause) =>
                  new ServerChatArchiveError({
                    message:
                      cause instanceof Error ? cause.message : "Unable to read the chat archive.",
                    cause,
                  }),
              });
              const sourceProjectTitles = new Set(
                manifest.threads.map((thread) => thread.sourceProjectTitle),
              );
              const projectId = ProjectId.make(crypto.randomUUID());
              const threadIdBySourceId = new Map(
                manifest.threads.map(
                  (thread) => [thread.sourceThreadId, ThreadId.make(crypto.randomUUID())] as const,
                ),
              );
              const threads = manifest.threads.map((thread) => {
                const turnIdBySourceId = new Map<string, TurnId>();
                return {
                  threadId: threadIdBySourceId.get(thread.sourceThreadId)!,
                  parentThreadId:
                    thread.sourceParentThreadId === null
                      ? null
                      : (threadIdBySourceId.get(thread.sourceParentThreadId) ?? null),
                  title:
                    sourceProjectTitles.size > 1
                      ? `${thread.sourceProjectTitle}: ${thread.title}`
                      : thread.title,
                  modelSelection: thread.modelSelection,
                  runtimeMode: thread.runtimeMode,
                  interactionMode: thread.interactionMode,
                  createdAt: thread.createdAt,
                  updatedAt: thread.updatedAt,
                  messages: thread.messages.map((message) => {
                    const turnId =
                      message.sourceTurnId === null
                        ? null
                        : (turnIdBySourceId.get(message.sourceTurnId) ??
                          (() => {
                            const id = TurnId.make(crypto.randomUUID());
                            turnIdBySourceId.set(message.sourceTurnId!, id);
                            return id;
                          })());
                    return {
                      messageId: MessageId.make(crypto.randomUUID()),
                      role: message.role,
                      text: importedMessageText(message),
                      turnId,
                      createdAt: message.createdAt,
                      updatedAt: message.updatedAt,
                    };
                  }),
                };
              });
              yield* orchestrationEngine
                .dispatch({
                  type: "chat-archive.import",
                  commandId: CommandId.make(crypto.randomUUID()),
                  projectId,
                  title: manifest.title,
                  workspaceRoot: NodePath.resolve(input.path),
                  threads,
                  createdAt: new Date().toISOString(),
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerChatArchiveError({
                        message: "Unable to import the chat archive.",
                        cause,
                      }),
                  ),
                );
              return { projectId, threadCount: threads.length };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.workflowRun]: (input) =>
          observeRpcEffect(WS_METHODS.workflowRun, runWorkflow(input), {
            "rpc.aggregate": "workflow",
          }),
        [WS_METHODS.serverExportThreadMarkdown]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverExportThreadMarkdown,
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings.pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerExportThreadMarkdownError({
                      message: cause.message,
                      cause,
                    }),
                ),
              );
              const exportDirectory = settings.chatExportDirectory.trim();
              if (exportDirectory.length === 0) {
                return yield* new ServerExportThreadMarkdownError({
                  message: "Set a chat export directory in Settings before exporting.",
                });
              }

              // Exports need full history: the default thread-detail read caps
              // message hydration to the newest MAX_THREAD_MESSAGES window.
              const threadOption = yield* projectionSnapshotQuery
                .getThreadDetailById(input.threadId, { unboundedMessages: true })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerExportThreadMarkdownError({
                        message: "Unable to load the chat for export.",
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(threadOption)) {
                return yield* new ServerExportThreadMarkdownError({
                  message: "Chat not found.",
                });
              }

              const thread = threadOption.value;
              const projectOption = yield* projectionSnapshotQuery
                .getProjectShellById(thread.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerExportThreadMarkdownError({
                        message: "Unable to load project metadata for export.",
                        cause,
                      }),
                  ),
                );
              const exportedAt = new Date();
              const filename = createThreadMarkdownExportFilename({
                title: thread.title,
                exportedAt,
              });
              const path = yield* Effect.tryPromise({
                try: () =>
                  writeThreadMarkdownExportFile({
                    directory: exportDirectory,
                    filename,
                    contents: formatThreadMarkdownExport({
                      thread,
                      project: Option.isSome(projectOption) ? projectOption.value : null,
                      exportedAt,
                      detail: settings.chatExportDetail,
                    }),
                  }),
                catch: (cause) =>
                  new ServerExportThreadMarkdownError({
                    message: "Unable to write chat export file.",
                    cause,
                  }),
              });

              yield* open.openInEditor({ cwd: path, editor: input.editor }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerExportThreadMarkdownError({
                      message: `Chat exported to ${path}, but it could not be opened.`,
                      cause,
                    }),
                ),
              );

              return { path, filename };
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            Effect.gen(function* () {
              // Bind the scope before the closures below: TypeScript drops
              // property narrowing of `input.scope` inside nested generators.
              const cwd = yield* Effect.gen(function* () {
                if ("cwd" in input) {
                  return input.cwd;
                }
                const scope = input.scope;
                if (scope._tag === "thread") {
                  const thread = yield* projectionSnapshotQuery
                    .getThreadDetailById(scope.threadId)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProjectSearchEntriesError({
                            message: "Unable to authorize workspace entry search.",
                            cause,
                          }),
                      ),
                    );
                  if (Option.isNone(thread)) {
                    return yield* new ProjectSearchEntriesError({
                      message: "Workspace thread was not found.",
                    });
                  }
                  const project = yield* projectionSnapshotQuery
                    .getProjectShellById(thread.value.projectId)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProjectSearchEntriesError({
                            message: "Unable to authorize workspace entry search.",
                            cause,
                          }),
                      ),
                    );
                  if (Option.isNone(project)) {
                    return yield* new ProjectSearchEntriesError({
                      message: "Workspace project was not found.",
                    });
                  }
                  return thread.value.worktreePath ?? project.value.workspaceRoot;
                }
                return yield* projectionSnapshotQuery.getProjectShellById(scope.projectId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectSearchEntriesError({
                        message: "Unable to authorize workspace entry search.",
                        cause,
                      }),
                  ),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        new ProjectSearchEntriesError({
                          message: "Workspace project was not found.",
                        }),
                      onSome: (project) => Effect.succeed(project.workspaceRoot),
                    }),
                  ),
                );
              });
              return yield* workspaceEntries.search({
                cwd,
                query: input.query,
                limit: input.limit,
                ...("kind" in input && input.kind !== undefined ? { kind: input.kind } : {}),
              });
            }).pipe(
              Effect.mapError((cause) =>
                isProjectSearchEntriesError(cause)
                  ? cause
                  : new ProjectSearchEntriesError({
                      message: `Failed to search workspace entries: ${cause.detail}`,
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            // Empty-query search returns the full workspace index (files + dirs),
            // which is what mobile's file tree browser expects from listEntries.
            workspaceEntries
              .search({
                cwd: input.cwd,
                query: "",
                limit: 25_000,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectListEntriesError({
                      message: `Failed to list workspace entries: ${cause.detail}`,
                      cause,
                    }),
                ),
              ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(
            WS_METHODS.cloudGetRelayClientStatus,
            Option.match(relayClient, {
              onNone: () =>
                Effect.succeed({
                  status: "missing" as const,
                  version: RelayClient.CLOUDFLARED_VERSION,
                }),
              onSome: (client) => client.resolve,
            }),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                Option.match(relayClient, {
                  onNone: () =>
                    Queue.failCause(
                      queue,
                      Cause.fail(
                        new RelayClientInstallFailedError({
                          reason: "write_failed",
                          message: "Relay client management is not available on this server.",
                        }),
                      ),
                    ),
                  onSome: (client) =>
                    client
                      .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new RelayClientInstallFailedError({
                              reason: error.reason,
                              message: error.message,
                            }),
                        ),
                        Effect.matchCauseEffect({
                          onFailure: (cause) => Queue.failCause(queue, cause),
                          onSuccess: (status) =>
                            Queue.offer(queue, {
                              type: "complete" as const,
                              status,
                            }).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid),
                        }),
                      ),
                }),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            Effect.gen(function* () {
              if ("cwd" in input) {
                return yield* workspaceFileSystem.readFile(input);
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadDetailById(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectReadFileError({
                        message: "Unable to authorize workspace file access.",
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new ProjectReadFileError({
                  message: "Workspace thread was not found.",
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectReadFileError({
                        message: "Unable to authorize workspace file access.",
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new ProjectReadFileError({
                  message: "Workspace project was not found.",
                });
              }
              return yield* workspaceFileSystem.readFile({
                cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
                relativePath: input.relativePath,
              });
            }).pipe(
              Effect.mapError((cause) => {
                if (isProjectReadFileError(cause)) return cause;
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to read workspace file";
                return new ProjectReadFileError({ message, cause });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.shellRevealInFileManager]: (input) =>
          observeRpcEffect(
            WS_METHODS.shellRevealInFileManager,
            open.revealInFileManager(input.path),
            {
              "rpc.aggregate": "workspace",
            },
          ),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
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
              if (input.resource._tag === "native-app-icon") {
                return yield* new AssetWorkspaceContextNotFoundError({ resource: input.resource });
              }
              if (input.resource._tag === "attachment") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource._tag === "project-favicon") {
                const project = yield* projectionSnapshotQuery
                  .getProjectShellById(input.resource.projectId)
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
                  workspaceRoot: project.value.workspaceRoot,
                });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadDetailById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
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
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
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
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsList,
            withPullRequests((service) => service.list(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsListStats]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsListStats,
            withPullRequests((service) => service.listStats(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDetail,
            withPullRequests((service) => service.detail(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsActivity,
            withPullRequests((service) => service.activity(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRunAction,
            withPullRequests((service) => service.runAction(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsComment,
            withPullRequests((service) => service.comment(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSubmitReview,
            withPullRequests((service) => service.submitReview(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            withPullRequests((service) => service.replyToThread(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            withPullRequests((service) => service.setThreadResolution(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsInvalidate,
            withPullRequests((service) => service.invalidate(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            withPullRequests((service) => service.reviewerCandidates(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            withPullRequests((service) => service.requestReviewers(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestMonitorsStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsStart,
            withPullRequestMonitors((service) => service.start(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsStop]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsStop,
            withPullRequestMonitors((service) => service.stop(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsStatus,
            withPullRequestMonitors((service) => service.status(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsList,
            withPullRequestMonitors((service) => service.list(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.pullRequestMonitorsSubscribe,
            Stream.unwrap(
              withPullRequestMonitors((service) => Effect.succeed(service.subscribeList(input))),
            ),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsContext]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsContext,
            withPullRequestMonitors((service) => service.context(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsReport]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsReport,
            withPullRequestMonitors((service) => service.report(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsTransfer]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsTransfer,
            withPullRequestMonitors((service) => service.transferOwnership(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsSubmitFindings]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsSubmitFindings,
            withPullRequestMonitors((service) => service.submitFindings(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.pullRequestMonitorsLaunchFallback]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestMonitorsLaunchFallback,
            withPullRequestMonitors((service) => service.launchFallback(input)),
            { "rpc.aggregate": "pullRequestMonitors" },
          ),
        [WS_METHODS.collaborativeAcceptanceSubmitCandidate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptanceSubmitCandidate,
            withAcceptance((service) =>
              Effect.gen(function* () {
                const sender = yield* resolveAcceptanceThread(input.threadId);
                const existing =
                  input.submission.caseId === undefined
                    ? null
                    : (yield* service.status(input.submission.caseId)).record;
                const recipientThreadId =
                  existing?.case.parentThreadId ?? sender.parentThreadId ?? sender.id;
                const recipient = yield* resolveAcceptanceThread(recipientThreadId);
                const senderAuthority = acceptanceAuthorityForThread(sender);
                const recipientAuthority = acceptanceAuthorityForThread(recipient);
                if (senderAuthority === undefined || recipientAuthority === undefined) {
                  return yield* new CollaborativeAcceptanceError({
                    message: "Acceptance requires authenticated active execution authority.",
                  });
                }
                return yield* service.submitCandidate({
                  ...input.submission,
                  senderThreadId: sender.id,
                  recipientThreadId,
                  senderAuthority,
                  recipientAuthority,
                });
              }),
            ),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),
        [WS_METHODS.collaborativeAcceptanceRequestReview]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptanceRequestReview,
            withAcceptance((service) =>
              Effect.gen(function* () {
                const record = (yield* service.status(input.caseId)).record;
                if (record === null) {
                  return yield* new CollaborativeAcceptanceError({
                    message: "Acceptance case not found.",
                    caseId: input.caseId,
                  });
                }
                const sender = yield* resolveAcceptanceThread(input.threadId);
                const recipient = yield* resolveAcceptanceThread(record.case.parentThreadId);
                const senderAuthority = acceptanceAuthorityForThread(sender);
                const recipientAuthority = acceptanceAuthorityForThread(recipient);
                if (senderAuthority === undefined || recipientAuthority === undefined) {
                  return yield* new CollaborativeAcceptanceError({
                    message: "Acceptance requires authenticated active execution authority.",
                  });
                }
                return yield* service.requestReview({
                  caseId: input.caseId,
                  senderThreadId: sender.id,
                  recipientThreadId: recipient.id,
                  assignmentId: record.case.assignmentId,
                  senderAuthority,
                  recipientAuthority,
                });
              }),
            ),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),
        [WS_METHODS.collaborativeAcceptanceStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptanceStatus,
            withAcceptance((service) => service.status(input.caseId)),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),
        [WS_METHODS.collaborativeAcceptanceResolveForPullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptanceResolveForPullRequest,
            withAcceptanceLookup((service) =>
              Effect.gen(function* () {
                const thread = yield* resolveAcceptanceThread(input.threadId).pipe(
                  Effect.mapError(
                    () =>
                      new CollaborativeAcceptanceCaseLookupError({
                        message: "The acceptance thread is unavailable.",
                        reason: "unavailable",
                      }),
                  ),
                );
                if (!hasDurablePullRequestAssociation(thread, input.pullRequest)) {
                  return yield* new CollaborativeAcceptanceCaseLookupError({
                    message: "The pull request is not durably associated with this thread.",
                    reason:
                      thread.projectId === input.pullRequest.projectId
                        ? "not-found"
                        : "unauthorized",
                  });
                }
                return yield* service.resolveForPullRequest(input);
              }),
            ),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),
        [WS_METHODS.collaborativeAcceptanceSubmitAssessment]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptanceSubmitAssessment,
            withAcceptance((service) =>
              Effect.gen(function* () {
                const thread = yield* resolveAcceptanceThread(input.threadId);
                const authority = acceptanceAuthorityForThread(thread);
                if (authority === undefined) {
                  return yield* new CollaborativeAcceptanceError({
                    message: "Acceptance requires authenticated active execution authority.",
                  });
                }
                return yield* service.submitAssessment({
                  ...input.submission,
                  authority,
                });
              }),
            ),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),
        [WS_METHODS.collaborativeAcceptancePause]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptancePause,
            withAcceptance((service) =>
              Effect.gen(function* () {
                const thread = yield* resolveAcceptanceThread(input.threadId);
                const authority = acceptanceAuthorityForThread(thread);
                if (authority === undefined) {
                  return yield* new CollaborativeAcceptanceError({
                    message: "Acceptance requires authenticated active execution authority.",
                  });
                }
                return yield* service.pause(input.caseId, input.reason, authority);
              }),
            ),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),
        [WS_METHODS.collaborativeAcceptanceResume]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborativeAcceptanceResume,
            withAcceptance((service) =>
              Effect.gen(function* () {
                const thread = yield* resolveAcceptanceThread(input.threadId);
                const authority = acceptanceAuthorityForThread(thread);
                if (authority === undefined) {
                  return yield* new CollaborativeAcceptanceError({
                    message: "Acceptance requires authenticated active execution authority.",
                  });
                }
                return yield* service.resume(input.caseId, authority);
              }),
            ),
            { "rpc.aggregate": "collaborativeAcceptance" },
          ),

        [WS_METHODS.subscribeGitStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeGitStatus,
            gitStatusBroadcaster.streamStatus(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRefreshStatus,
            gitStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitLocalStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitLocalStatus,
            gitManager
              .invalidateLocalStatus(input.cwd)
              .pipe(Effect.andThen(gitManager.localStatus(input))),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPull,
            checkoutCoordinator.withCheckout(input.cwd, git.pullCurrentBranch(input.cwd)).pipe(
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
              gitManager
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
                      Effect.gen(function* () {
                        const createdPrNumber = result.pr.number;
                        const projectId = input.projectId;
                        const threadId = input.threadId;
                        if (
                          result.pr.status === "created" &&
                          typeof createdPrNumber === "number" &&
                          projectId !== undefined &&
                          threadId !== undefined
                        ) {
                          const settingsResult = yield* Effect.result(serverSettings.getSettings);
                          const enabled =
                            Result.isSuccess(settingsResult) &&
                            settingsResult.success.autoMonitorPullRequestsOnCreate === true;
                          const repository = repositoryFromPullRequestUrl(result.pr.url);
                          if (enabled && repository) {
                            yield* withPullRequestMonitors((service) =>
                              service.start({
                                projectId,
                                repository,
                                number: createdPrNumber,
                                ownerThreadId: threadId,
                              }),
                            ).pipe(Effect.ignore({ log: true }));
                          }
                        }
                        yield* refreshGitStatus(input.cwd);
                        yield* Queue.end(queue);
                      }).pipe(Effect.asVoid),
                  }),
                ),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitManager.resolvePullRequest(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitManager
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitResolveReviewChangesContext]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolveReviewChangesContext,
            git.resolveReviewChangesContext(input),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitPrewarmReviewChangesContext]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPrewarmReviewChangesContext,
            git.prewarmReviewChangesContext(input),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitListOpenPullRequests]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitListOpenPullRequests,
            Option.match(gitHubCli, {
              onNone: () =>
                Effect.fail(
                  new GitHubCliError({
                    operation: "listOpenPullRequests",
                    detail: "GitHub CLI integration is unavailable.",
                  }),
                ),
              onSome: (service) =>
                service.listRepositoryOpenPullRequests({ cwd: input.cwd }).pipe(
                  Effect.map((pullRequests) => ({
                    pullRequests: pullRequests.map((pullRequest) => ({
                      number: pullRequest.number,
                      title: pullRequest.title,
                      url: pullRequest.url,
                      baseBranch: pullRequest.baseRefName,
                      headBranch: pullRequest.headRefName,
                      state: pullRequest.state ?? "open",
                    })),
                  })),
                ),
            }),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitListBranches]: (input) =>
          observeRpcEffect(WS_METHODS.gitListBranches, git.listBranches(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateWorktree,
            checkoutCoordinator
              .withCheckout(input.cwd, git.createWorktree(input))
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRemoveWorktree,
            checkoutCoordinator
              .withCheckout(NodePath.resolve(input.cwd, input.path), git.removeWorktree(input))
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateBranch,
            checkoutCoordinator
              .withCheckout(input.cwd, git.createBranch(input))
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCheckout,
            checkoutCoordinator
              .withCheckout(input.cwd, Effect.scoped(git.checkoutBranch(input)))
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitInit,
            checkoutCoordinator
              .withCheckout(input.cwd, git.initRepo(input))
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.map(filterArchivedShellSnapshot),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        // VCS RPCs delegate to the fork's git layers and translate result
        // shapes through VcsBridge (the fork is git-first).
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            gitStatusBroadcaster.streamStatus(input).pipe(Stream.map(gitStatusStreamEventToVcs)),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            gitStatusBroadcaster.refreshStatus(input.cwd).pipe(Effect.map(gitStatusToVcs)),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            checkoutCoordinator.withCheckout(input.cwd, git.pullCurrentBranch(input.cwd)).pipe(
              Effect.map(gitPullResultToVcs),
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsListRefs,
            git.listBranches(vcsListRefsInputToGit(input)).pipe(Effect.map(gitListBranchesToVcs)),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            checkoutCoordinator
              .withCheckout(input.cwd, git.createWorktree(vcsCreateWorktreeInputToGit(input)))
              .pipe(
                Effect.map(gitCreateWorktreeResultToVcs),
                Effect.tap(() => refreshGitStatus(input.cwd)),
              ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            checkoutCoordinator
              .withCheckout(NodePath.resolve(input.cwd, input.path), git.removeWorktree(input))
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            checkoutCoordinator
              .withCheckout(input.cwd, git.createBranch(vcsCreateRefInputToGit(input)))
              .pipe(
                Effect.map(gitCreateBranchResultToVcs),
                Effect.tap(() => refreshGitStatus(input.cwd)),
              ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            checkoutCoordinator
              .withCheckout(
                input.cwd,
                Effect.scoped(git.checkoutBranch({ cwd: input.cwd, branch: input.refName })),
              )
              .pipe(
                Effect.map(gitCheckoutResultToVcs),
                Effect.tap(() => refreshGitStatus(input.cwd)),
              ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            checkoutCoordinator.withCheckout(input.cwd, git.initRepo({ cwd: input.cwd })).pipe(
              Effect.mapError((error): VcsError => gitCommandErrorToVcs(error)),
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        // Source-control provider integration is not implemented in the
        // git-first fork; report empty discovery and fail explicit operations.
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            Effect.succeed({ versionControlSystems: [], sourceControlProviders: [] }),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            Effect.fail(
              new SourceControlRepositoryError({
                provider: input.provider,
                operation: "lookupRepository",
                detail: "Source-control provider integration is not available on this server.",
              }),
            ),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            Effect.fail(
              new SourceControlRepositoryError({
                provider: input.provider ?? "github",
                operation: "cloneRepository",
                detail: "Source-control provider integration is not available on this server.",
              }),
            ),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            Effect.fail(
              new SourceControlRepositoryError({
                provider: input.provider,
                operation: "publishRepository",
                detail: "Source-control provider integration is not available on this server.",
              }),
            ),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (_input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffPreview,
            Effect.fail(
              new VcsUnsupportedOperationError({
                operation: "reviewGetDiffPreview",
                kind: "git",
                detail: "Live diff preview is not available on this server.",
              }),
            ),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            Effect.fail(
              new ServerProviderUpdateError({
                provider: input.provider,
                reason: "Provider self-update is not available on this server.",
              }),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.fail(
              new KeybindingsConfigError({
                configPath: config.keybindingsConfigPath,
                detail: "Removing keybindings is not supported on this server.",
              }),
            ),
            { "rpc.aggregate": "server" },
          ),
        // Process/trace diagnostics are not instrumented in the fork; return
        // well-formed empty snapshots so the client renders an empty state.
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                traceFilePath: "unavailable",
                scannedFilePaths: [],
                readAt: now,
                recordCount: 0,
                parseErrorCount: 0,
                firstSpanAt: Option.none(),
                lastSpanAt: Option.none(),
                failureCount: 0,
                interruptionCount: 0,
                slowSpanThresholdMs: 0,
                slowSpanCount: 0,
                logLevelCounts: {},
                topSpansByCount: [],
                slowestSpans: [],
                commonFailures: [],
                latestFailures: [],
                latestWarningAndErrorLogs: [],
                partialFailure: Option.none(),
                error: Option.none(),
              };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessDiagnostics,
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                serverPid: process.pid,
                readAt: now,
                processCount: 0,
                totalRssBytes: 0,
                totalCpuPercent: 0,
                processes: [],
                error: Option.none(),
              };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                readAt: now,
                windowMs: input.windowMs,
                bucketMs: input.bucketMs,
                sampleIntervalMs: 0,
                retainedSampleCount: 0,
                totalCpuSecondsApprox: 0,
                buckets: [],
                topProcesses: [],
                error: Option.none(),
              };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSignalProcess,
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: false,
              message: Option.some("Process signaling is not supported on this server."),
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReportClientActivity]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportClientActivity,
            backgroundPolicy.reportClientActivity(currentSessionId, backgroundConnection, input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetBackgroundPolicy,
            backgroundPolicy.snapshotForSession(currentSessionId),
            {
              "rpc.aggregate": "server",
            },
          ),
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
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
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
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.deviceConfigure]: (input) =>
          observeRpcEffect(WS_METHODS.deviceConfigure, deviceService.configure(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceTestHost]: (input) =>
          observeRpcEffect(WS_METHODS.deviceTestHost, deviceService.testHost(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceList]: (_input) =>
          observeRpcEffect(WS_METHODS.deviceList, deviceService.list, {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceOpen]: (input) =>
          observeRpcEffect(WS_METHODS.deviceOpen, deviceService.open(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceClose]: (input) =>
          observeRpcEffect(WS_METHODS.deviceClose, deviceService.close(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceShutdown]: (input) =>
          observeRpcEffect(WS_METHODS.deviceShutdown, deviceService.shutdown(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceDetail]: (input) =>
          observeRpcEffect(WS_METHODS.deviceDetail, deviceService.detail(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceAction]: (input) =>
          observeRpcEffect(WS_METHODS.deviceAction, deviceService.action(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.subscribeDeviceState]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDeviceState,
            DeviceService.stateStream(deviceService),
            { "rpc.aggregate": "device" },
          ),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                yield* portDiscovery.retain;
                const offerServers = (servers: ReadonlyArray<DiscoveredLocalServer>) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, { servers, scannedAt });
                  });
                yield* offerServers(yield* portDiscovery.scan());
                yield* portDiscovery.subscribe(offerServers);
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
                Stream.map((settings) => redactServerSettingsForClient(settings)),
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
        [WS_METHODS.subscribeSidebarState]: (_input) =>
          observeRpcStream(WS_METHODS.subscribeSidebarState, sidebarState.changes, {
            "rpc.aggregate": "sidebar",
          }),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot(serverAuth, currentSessionId);
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
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
              Effect.map(
                backgroundPolicy.subscribeForSession(currentSessionId),
                ({ latest, changes }) => Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const backgroundConnection = allocateBackgroundConnectionIdentity();
        const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
        const connectionId = crypto.randomUUID();
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              makeWsRpcLayer(session, backgroundConnection),
              crossVersionRpcSerializationLayer,
              rpcAuthorizationLayer(new Set(session.scopes), session.role),
            ),
          ),
        );
        const waitUntilSessionInactive = sessions
          .waitUntilInactive(session.sessionId)
          .pipe(Effect.as(HttpServerResponse.empty({ status: 401 })));
        // A silently replaced socket leaves every subscription on the old
        // connection dead, so connection open/close is the anchor every stream
        // log below correlates against.
        const connectedAt = Date.now();
        return yield* Effect.acquireUseRelease(
          Effect.all(
            [
              sessions.markConnected(session.sessionId),
              backgroundPolicy.registerConnection(session.sessionId, backgroundConnection),
            ],
            { discard: true, concurrency: "unbounded" },
          ),
          () =>
            Effect.logInfo("websocket connected", {
              userAgent: request.headers["user-agent"],
            }).pipe(
              Effect.andThen(Effect.raceFirst(rpcWebSocketHttpEffect, waitUntilSessionInactive)),
              Effect.onExit((exit) =>
                Effect.logInfo("websocket disconnected", {
                  durationMs: Date.now() - connectedAt,
                  outcome: outcomeFromExit(exit),
                  ...(Exit.isFailure(exit) ? { cause: Cause.pretty(exit.cause) } : {}),
                }),
              ),
              withLogContext({ sessionId: session.sessionId, connectionId }),
            ),
          () =>
            Effect.all(
              [
                backgroundPolicy.removeConnection(session.sessionId, backgroundConnection),
                sessions.markDisconnected(session.sessionId),
              ],
              { discard: true, concurrency: "unbounded" },
            ),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
