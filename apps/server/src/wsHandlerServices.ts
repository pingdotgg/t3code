import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerSettings from "./serverSettings.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { commandFeatureUsage, featureUsage } from "./telemetry/FeatureUsage.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";

// Extracted from ./ws.ts: the services layerWsRpc's RPC handlers close over.
export interface WsHandlerServicesParams {
  currentSession: EnvironmentAuth.AuthenticatedSession;
  clientAnalyticsProps: Readonly<Record<string, unknown>>;
}

export const makeWsHandlerServices = Effect.fn("ws.makeHandlerServices")(function* (
  params: WsHandlerServicesParams,
) {
  const { currentSession, clientAnalyticsProps } = params;

  const currentSessionId = currentSession.sessionId;
  const sql = yield* SqlClient.SqlClient;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const intakeContext = yield* Effect.context<
    | ThreadManagementService.ThreadManagementService
    | ThreadLaunchService.ThreadLaunchService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | ServerSettings.ServerSettingsService
    | DocumentText.DocumentText
  >();
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projectService = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const scratchThreadPromotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
  const eventLoopMonitor = yield* EventLoopMonitor.EventLoopMonitor;
  const threadSearch = yield* ThreadSearch.ThreadSearch;

  const providerSessionsV2 = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const originProps = clientAnalyticsProps;
  const recordClientCommandAnalytics = (command: OrchestrationV2Command) => {
    const usage = commandFeatureUsage(command);
    return Effect.all(
      [
        command.type === "message.dispatch"
          ? analytics.record("client.turn.requested", originProps)
          : Effect.void,
        usage === undefined
          ? Effect.void
          : analytics.record("feature.used", {
              ...usage,
              ...(originProps.surface === undefined ? {} : { surface: originProps.surface }),
            }),
      ],
      { discard: true },
    ).pipe(Effect.ignore);
  };
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const commandOutputHub = yield* CommandOutputHub.CommandOutputHub;
  const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const guestShares = yield* GuestShareService.GuestShareService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const deviceService = yield* DeviceService.DeviceService;
  const deviceHostContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
  const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  // RPC client ids are only unique within one socket; terminals share viewers across sockets.
  const terminalViewerPrefix = yield* random.uuidV4();
  const terminalViewerId = (metadata: { readonly client: { readonly id: number } }) =>
    `${terminalViewerPrefix}:${metadata.client.id}`;
  const serverCommandId = (tag: string) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
    );
  const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
    reference.host !== undefined && reference.repository.includes("/")
      ? Effect.succeed(pullRequestSyncKey(reference))
      : projectService.getShell(reference.projectId).pipe(
          Effect.map((project) =>
            pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
          ),
          Effect.orElseSucceed(() => null),
        );
  const usage = yield* UsageService.UsageService;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const repositoryIdentityResolver =
    yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
  const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
  const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const nativeChildWork = yield* NativeChildWorkQuery.NativeChildWorkQuery;
  const keybindings = yield* Keybindings.Keybindings;
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const review = yield* ReviewService.ReviewService;
  const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const previewManager = yield* PreviewManager.PreviewManager;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const acpRegistryCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const acpRegistryRuntimeCoordinator =
    yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const providerAuth = yield* ProviderAuthService.ProviderAuthService;
  const providerInstallation = yield* makeProviderInstallation();
  const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const npmRelease = yield* NpmRelease.NpmRelease;
  const config = yield* ServerConfig.ServerConfig;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const storageCleanup = yield* StorageCleanup.StorageCleanup;
  const databaseStorage = yield* DatabaseStorage.DatabaseStorage;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
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
  const otlpEndpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
  const sourceControlRepositories =
    yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const sourceControlSignIn = yield* SourceControlSignIn.SourceControlSignIn;
  const withPullRequestViewer = pullRequests.withRoutingCredential;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
  const triage = yield* TriageService.TriageService;
  const hostResources = yield* HostResources.HostResources;
  const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
  const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const relayClient = yield* RelayClient.RelayClient;
  // Webhook URLs start agents; expose them only to operate-scoped sessions while keeping tasks readable.

  return {
    currentSessionId,
    sql,
    threadManagement,
    intakeContext,
    applicationEvents,
    projectStore,
    projectService,
    managedFolders,
    scratchThreadPromotion,
    eventLoopMonitor,
    threadSearch,
    providerSessionsV2,
    mcpAppRequests,
    analytics,
    originProps,
    recordClientCommandAnalytics,
    threadLaunch,
    commandOutputHub,
    providerSessionManager,
    scheduledTasks,
    secretRequests,
    guestShares,
    pullRequests,
    reviewGuides,
    pullRequestSync,
    deviceService,
    deviceHostContext,
    orchestrationEngine,
    random,
    terminalViewerPrefix,
    terminalViewerId,
    serverCommandId,
    resolvePullRequestSyncKey,
    usage,
    usageLimitSources,
    worktreeSetupTracker,
    projectCloneTracker,
    repositoryIdentityResolver,
    projectEnrichment,
    agentSessionScanner,
    agentSessionImporter,
    checkpointDiffQuery,
    nativeChildWork,
    keybindings,
    environmentTheme,
    externalLauncher,
    remoteOpenTargets,
    directEndpoints,
    gitWorkflow,
    review,
    vcsProvisioning,
    vcsStatusBroadcaster,
    terminalManager,
    previewManager,
    portDiscovery,
    providerRegistry,
    providerInstances,
    acpRegistryCatalog,
    acpRegistryRuntimeCoordinator,
    providerMaintenanceRunner,
    providerAuth,
    providerInstallation,
    serverSelfUpdate,
    npmRelease,
    config,
    lifecycleEvents,
    storageCleanup,
    databaseStorage,
    serverSettings,
    secretResolver,
    peerLinks,
    peerLinkRequests,
    startup,
    workspaceEntries,
    workspaceFileSystem,
    serverEnvironment,
    backgroundPolicy,
    rpcClientIds,
    serverAuth,
    sourceControlDiscovery,
    otlpEndpointCheck,
    sourceControlRepositories,
    sourceControlSignIn,
    withPullRequestViewer,
    bootstrapCredentials,
    sessions,
    processDiagnostics,
    triage,
    hostResources,
    processResourceMonitor,
    resourceTelemetry,
    relayClient,
  };
});

export type WsHandlerServices = Effect.Success<ReturnType<typeof makeWsHandlerServices>>;
