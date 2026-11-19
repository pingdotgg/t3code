import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as AssetSigner from "./assets/AssetSigner.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as WorktreeReclamation from "./workspace/WorktreeReclamation.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as McpGatewayBroker from "./mcp/McpGatewayBroker.ts";
import * as HeadlessGatewayHost from "./mcp/agents/HeadlessGatewayHost.ts";
import * as LocalGatewayPort from "./mcp/agents/LocalGatewayPort.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, type RepositoryIdentity } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ClientFocusBroker from "./clients/ClientFocusBroker.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as NonBlockingSpawner from "./process/NonBlockingSpawner.ts";
import * as KeepAwake from "./background/KeepAwake.ts";
import * as ServerConfig from "./config.ts";
import { withRootRequestSpans, withUntracedRequests } from "./http.ts";
import * as ServerHttp from "./http.ts";
import {
  guardHttpResponseWriteErrors,
  keepIdleConnections,
  rejectRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";
import { resolveLauncherPath } from "./service/pinnedRuntime.ts";
import { fixPath } from "./os-jank.ts";
import * as Ws from "./ws.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as AgentTempDirLive from "./process/agentTempDir.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as SpawnWorker from "./process/SpawnWorker.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as PullRequestHttp from "./pullRequest/http.ts";
import * as UpdatePauseHttp from "./updatePauseHttp.ts";
import * as SpeechModelStore from "./speech/SpeechModelStore.ts";
import * as SpeechService from "./speech/SpeechService.ts";
import * as CloudSpeech from "./speech/CloudSpeech.ts";
import { speechHttpApiLayer } from "./speech/http.ts";
import { speechStreamRouteLayer } from "./speech/stream.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as IssueTrackerConnections from "./issue/IssueTrackerConnections.ts";
import * as IssueTrackerBindings from "./persistence/IssueTrackerBindings.ts";
import * as IssueTrackerRegistry from "./issue/IssueTrackerRegistry.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/resetCreditCoordinator.ts";
import * as EventNdjsonLogger from "./provider/EventNdjsonLogger.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ProviderHostLive from "./provider/ProviderHostLive.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControl/sourceControlDefinitions.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import * as SecretResolver from "./secrets/SecretResolver.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as DefaultAgentSkills from "./defaultAgentSkills.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as PeerForwarding from "./peer/PeerForwarding.ts";
import * as RemoteDelegation from "./peer/RemoteDelegation.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as TailnetDevices from "./peer/TailnetDevices.ts";
import * as TailnetDevicesHttp from "./peer/tailnetDevicesHttp.ts";
import * as TailnetIdentity from "./peer/TailnetIdentity.ts";
import * as PeerMcpClient from "./peer/PeerMcpClient.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";
import * as ComputerService from "./computer/ComputerService.ts";
import * as ComputerApprovals from "./computer/ComputerApprovals.ts";
import * as ComputerAudit from "./computer/ComputerAudit.ts";
import * as ComputerDecider from "./computer/ComputerDecider.ts";
import * as LocalComputerHost from "./computer/LocalComputerHost.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewTunnel from "./preview/PreviewTunnel.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as PreviewAgentActivity from "./preview/PreviewAgentActivity.ts";
import * as DesktopBrowserChannel from "./preview/DesktopBrowserChannel.ts";
import * as ServerBrowserStream from "./preview/ServerBrowserStream.ts";
import * as PreviewBrowser from "./preview/PreviewBrowser.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerShutdown from "./serverShutdown.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ManagedLimits from "./policy/managedLimits.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as ProviderInstallationGate from "./provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "./provider/ProviderUsageLimitsIngestion.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsAutomaticFetchInterval from "./vcs/VcsAutomaticFetchInterval.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as Observability from "./observability/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { watchTailnetRoute } from "./environment/TailnetRouteCheck.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as CodexManagedTokenBroker from "./provider/CodexManagedTokenBroker.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import { ScheduledTaskWebhookOrigin } from "./scheduledTasks/ScheduledTaskService.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentAuthPolicy from "./auth/EnvironmentAuthPolicy.ts";
import * as ServerSelfUpdate from "./service/selfUpdate.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./service/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ProcessGroupMetrics from "./resourceTelemetry/ProcessGroupMetrics.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as AntigravityUsage from "./provider/Drivers/AntigravityUsage.ts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as UsageService from "./usage/UsageService.ts";
import * as CodexUsageHistory from "./usage/CodexUsageHistory.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";
import * as PushNotifier from "./push/PushNotifier.ts";
import * as PushRegistrations from "./push/PushRegistrations.ts";
import * as ThreadTaskService from "./threadTask/ThreadTaskService.ts";
import * as ThreadTaskTransport from "./threadTask/ThreadTaskTransport.ts";
import * as IdleCompactionService from "./orchestration-v2/IdleCompactionService.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import { makePersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { closeNonPrivateNetworkConnections, loopbackUrlHostForAddress } from "./startupAccess.ts";
import * as ConnectTeardown from "./environment/ConnectTeardown.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as ProjectHttp from "./project/http.ts";
import * as NetService from "@t3tools/shared/Net";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeRootHolder,
  readTailscaleServeRoutesTo,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import {
  chooseTailscaleServePort,
  expectedTailscaleServePort,
  writeLastTailscaleServePort,
} from "./environment/TailscaleServePort.ts";
import * as ServerActivation from "./serverActivation.ts";

// Escaped MCP handoff provenance can exceed find-my-way's 100-character segment default.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Skip Effect's default 20 s grace; WebSocket scope finalizers already close connections gracefully.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const layerResourceAttribution = ResourceAttribution.layer;
const layerApplicationObservability = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(layerResourceAttribution),
);

// Share rotation state so driver loggers cannot race.
const layerProviderEventLoggers = Layer.effect(
  ProviderEventLoggers.ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;
    const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
      attribution,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { error }).pipe(
          Effect.annotateLogs({ scope: "provider-observability" }),
          Effect.as(undefined),
        ),
      ),
    );
    if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
    yield* Effect.addFinalizer(() => store.close());
    return { native: store.logger("native"), canonical: store.logger("canonical") };
  }),
);

const layerPtyAdapter = NodePtyAdapter.layer;

const layerServerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const layerDesktopTelemetryReceiver = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(layerServerSettings),
);

const layerResourceTelemetry = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(layerNativeTelemetry),
  Layer.provideMerge(layerDesktopTelemetryReceiver),
);

const layerHostPowerMonitor = HostPowerMonitor.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

// A fresh receiver layer would open a second reader on the desktop telemetry fd.
const layerDesktopAppUpdate = DesktopAppUpdate.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

const layerBackground = BackgroundPolicy.layer.pipe(
  Layer.provide(layerHostPowerMonitor),
  Layer.provideMerge(layerServerSettings),
);

const layerUsage = UsageService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AntigravityUsage.layer,
      MuseUsageHome.layer,
      CodexUsageHistory.layer,
      CursorUsageAccounts.layer.pipe(Layer.provide(CursorAccountReader.layer)),
    ).pipe(Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(ServerSecretStore.layer)))),
  ),
  Layer.provide(layerServerSettings),
);

const layerResourceDiagnostics = Layer.mergeAll(
  HostResources.layer,
  layerResourceTelemetry,
  ProcessDiagnostics.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessGroupMetrics.layer.pipe(Layer.provide(layerResourceTelemetry)),
);

// NodeServices and NodeHttpServer each output Node's own spawner, so each is followed by this one.
const layerSpawner = SpawnWorker.layerServer.pipe(Layer.provide(NodeServices.layer));

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before binding: a host the policy does not allow must never listen, not even briefly.
    const policy = yield* ManagedPolicy.ManagedPolicy;
    const bindHost = yield* ManagedLimits.checkServerReachability(policy, {
      authPolicy: EnvironmentAuthPolicy.resolveServerAuthPolicy(config),
      host: config.host,
      tailscaleServeEnabled: config.tailscaleServeEnabled,
      privateNetworkOnly: config.privateNetworkOnly,
    });
    yield* ManagedLimits.closeTailscaleServeTo(policy, { host: bindHost, port: config.port });
    const runSync = Effect.runSyncWith(yield* Effect.context<never>());
    return NodeHttpServer.layer(
      () => {
        const server = rejectRequestsUntilServing(
          keepIdleConnections(guardHttpResponseWriteErrors(NodeHttp.createServer())),
        );
        if (config.privateNetworkOnly) {
          runSync(closeNonPrivateNetworkConnections(server));
        }
        return server;
      },
      {
        host: bindHost,
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        websocket: { perMessageDeflate: true },
      },
    ).pipe(Layer.merge(layerSpawner));
  }),
).pipe(
  Layer.provide(ManagedPolicy.layer),
  // NodeHttpServer.layer also outputs NodeServices, whose spawner would shadow the wrapped one.
  (layer) => NonBlockingSpawner.layer.pipe(Layer.provideMerge(layer)),
);

const layerPlatformServices = DocumentText.layer.pipe(
  Layer.provideMerge(NonBlockingSpawner.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSpawner)),
);

const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer));

const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerRepositoryIdentityResolver = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        for (const { kind } of BUILT_IN_SOURCE_CONTROL_DRIVER_LIST) {
          const provider = yield* registry.get(kind);
          if (provider.refineRepositoryIdentity === undefined) continue;
          const refined = yield* provider.refineRepositoryIdentity({
            identity,
            resolveContext: (input) =>
              registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
          });
          if (refined !== identity) return refined;
        }
        return identity;
      }),
    });
  }),
).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
);

// Both read the one registry, so a standalone tracker connected in Settings is the same
// instance the listing reads through.
const layerIssueService = Layer.merge(IssueService.layer, IssueTrackerConnections.layer).pipe(
  Layer.provide(Layer.merge(IssueTrackerRegistry.layer, IssueTrackerBindings.layer)),
);

// One instance serves MCP link calls and refreshes snapshots on thread events.
const layerThreadIssueService = ThreadIssueService.layer;

const layerGitManager = GitManager.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
  Layer.provide(layerPullRequestService.pipe(Layer.provide(RuntimeLayer.layerProjectService))),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
);

const layerGit = Layer.empty.pipe(
  Layer.provideMerge(layerGitManager),
  Layer.provideMerge(GitVcsDriver.layer),
);

const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(layerGit),
);

const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(
  Layer.provide(layerSourceControlRepositoryService),
);

const layerKnownWorkspaces = KnownWorkspaces.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(GitVcsDriver.layer),
);

const layerReview = ReviewService.layer.pipe(
  Layer.provideMerge(layerKnownWorkspaces),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerVcs = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provideMerge(layerGitWorkflow),
  Layer.provideMerge(layerReview),
  Layer.provideMerge(layerSourceControlRepositoryService),
  Layer.provideMerge(
    SourceControlSignIn.layer.pipe(Layer.provide(layerSourceControlProviderRegistry)),
  ),
  Layer.provideMerge(layerProjectCloneTracker),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(layerGitWorkflow),
      // The orchestration runtime also consumes the broadcaster (run
      // finalization), so the policy cannot read the store from the runtime's
      // output.
      Layer.provide(
        VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerPortScanner = PortScanner.layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(layerBackground),
);

const layerTerminal = TerminalManager.layer(
  ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap,
).pipe(
  Layer.provide(layerPtyAdapter),
  Layer.provide(layerPortScanner),
  Layer.provide(layerNativeTelemetry),
);

const layerPreview = Layer.empty.pipe(
  Layer.provideMerge(PreviewTunnel.layer),
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(layerPortScanner),
);

const layerDevice = DeviceService.layer.pipe(
  Layer.provide(layerServerSettings),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

const layerWorkspaceEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const layerWorkspaceFileSystem = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(layerWorkspaceEntries),
  Layer.provide(layerKnownWorkspaces),
);

const layerWorkspace = Layer.mergeAll(
  WorkspacePaths.layer,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
);

const layerProjectFaviconResolver = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

const layerServerEnvironment = ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(layerPersistence),
  Layer.provide(layerServerEnvironment),
  Layer.provide(ServerSecretStore.layer),
);

// Webhook URLs use this machine's tailnet HTTPS address; only senders on the tailnet reach it.
const layerScheduledTaskWebhookOrigin = Layer.effect(
  ScheduledTaskWebhookOrigin,
  Effect.gen(function* () {
    const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
    // Learn the served address once at startup; listings only read what is already known.
    yield* Effect.forkDetach(directEndpoints.resolve());
    return directEndpoints.resolveAvailable().pipe(
      Effect.map((endpoints) => ({
        tailnetOrigin:
          endpoints.find(
            (endpoint) => endpoint.kind === "tailnet" && endpoint.httpBaseUrl.startsWith("https:"),
          )?.httpBaseUrl ?? null,
      })),
    );
  }),
);

// Links to other environments: one instance for Settings, agents and remote settlement.
const layerPeerLinks = PeerMcpClient.layer.pipe(
  Layer.provideMerge(TailnetDevices.layer.pipe(Layer.provide(TailnetIdentity.layer))),
  Layer.provideMerge(PeerLinks.layer),
);

// Reaches other environments through connected apps, else over this server's own links.
const layerMcpGatewayBroker = McpGatewayBroker.layer.pipe(Layer.provide(layerPeerLinks));

// One computer-use capability for the server: hosts, tasks, approvals and their audit.
const layerComputer = ComputerService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ComputerApprovals.layer, ComputerAudit.layer, ComputerDecider.layer),
  ),
  Layer.provide(ProjectionStoreV2.layer),
);

const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
  // Tasks split across machines reach the other environment through the same
  // broker the WebSocket routes serve (one memoized instance).
  Layer.provide(ThreadTaskTransport.layerFromBroker.pipe(Layer.provide(layerMcpGatewayBroker))),
  // RemoteParentSettlement asks other environments through the same broker.
  Layer.provide(layerMcpGatewayBroker),
  // Remote settlement settles children over this server's own links first.
  Layer.provide(layerPeerLinks),
  Layer.provide(UsageLimitSources.layerResetFallback),
  Layer.provide(layerScheduledTaskWebhookOrigin),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const layerOrchestrationApplication = Layer.merge(
  CheckpointDiffQuery.layer,
  NativeChildWorkQuery.layer,
).pipe(
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(layerOrchestrationV2Runtime),
  // The effect worker's interrupt hook stops a thread's computer task; clients read the same instance.
  Layer.provideMerge(layerComputer),
);

const layerThreadSettlementWorker = Layer.effectDiscard(
  ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService), Layer.provide(ProjectionStoreV2.layer));

// Wakes task owners on their workers' runs and questions, and settles accepted tasks.
const layerThreadTaskWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* ThreadTaskService.ThreadTaskService).start();
  }),
);
const layerIdleCompactionWorker = Layer.effectDiscard(
  IdleCompactionService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(ProjectionStoreV2.layer));

// Fork: pushes straight to registered phones through Expo.
const layerPushNotifierWorker = Layer.effectDiscard(
  PushNotifier.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(PushRegistrations.layer));

const layerThreadPullRequestWorker = Layer.effectDiscard(
  ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService));

const layerProviderInstallationRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
    const codex = yield* CodexInstallation.CodexInstallation;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    yield* Stream.merge(
      antigravity.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
      codex.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
    ).pipe(
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

// The desktop app and the background service start the server again after it exits.
const layerServerRestart = Layer.effect(
  DatabaseStorage.ServerRestart,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    // As in runServerCommand, only the desktop app passes a bootstrap token; `serve --mode desktop` by hand has no supervisor.
    const desktopLaunched = config.mode === "desktop" && config.desktopBootstrapToken !== undefined;
    if (!desktopLaunched && !launcher.managed) return null;
    // Stop as a SIGTERM would: runMain's listener interrupts the server, so its shutdown path runs.
    return Effect.sync(() => void process.emit("SIGTERM"));
  }),
);

const layerRuntimeCoreDependenciesBase = Layer.mergeAll(
  layerThreadSettlementWorker,
  layerThreadTaskWorker,
  layerIdleCompactionWorker,
  StorageCleanup.layer.pipe(Layer.provide(ProjectionStoreV2.layer)),
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(layerServerRestart),
  ),
  layerThreadPullRequestWorker,
  layerPushNotifierWorker,
  WorktreeReclamation.layer.pipe(
    Layer.provide(ProjectionStoreV2.layer),
    Layer.provide(ProcessRunner.layer),
  ),
  KeepAwake.layer,
  // A macOS server outside the desktop app offers this computer to agents in process.
  LocalComputerHost.layer,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provideMerge(PullRequestSyncReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provide(PullRequestWatchReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      yield* service.start();
    }),
  ).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(ProjectionStoreV2.layer)),
  AgentTempDirLive.layerSettledCleanup.pipe(Layer.provide(ProjectionStoreV2.layer)),
  ProviderUsageLimitsIngestion.layer,
  layerProviderInstallationRefresh,
  ProviderInstallation.layer,
  ReplayMarkers.layer,
  Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
  // Waits for the settings runtime, which starts after these layers build.
  Layer.effectDiscard(Effect.forkScoped(DefaultAgentSkills.seed())),
).pipe(
  Layer.provideMerge(layerOrchestrationApplication),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  Layer.provideMerge(Layer.merge(ProjectStore.layer, ThreadSearch.layer)),
  Layer.provideMerge(SecretCheck.layer),
  Layer.provideMerge(SecretResolver.layer),
  // Above the settings it writes when a theme is applied.
  Layer.provideMerge(EnvironmentTheme.layer),
  Layer.provideMerge(layerServerSettings),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(Layer.mergeAll(layerTerminal, layerPreview, layerDevice)),
  Layer.provideMerge(layerPersistence),
  Layer.provideMerge(Layer.mergeAll(Keybindings.layer, UsageLimitSources.layer)),
  Layer.provideMerge(ProviderRegistry.layer),
  Layer.provideMerge(
    ProviderInstanceRegistryHydration.layer.pipe(Layer.provide(SqlitePersistence.layerConfig)),
  ),
  // One gate for the server, below hydration so the Claude adapter sees it: layers memoize by
  // reference, so the runtime layer shares it.
  Layer.provideMerge(ProviderInstallationGate.layer),
  // Provider hydration builds the Claude runner, which reports agents to the same scanner the
  // terminal and preview layers share.
  Layer.provideMerge(layerPortScanner),
  Layer.provideMerge(
    Layer.mergeAll(
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerSettings),
      ),
      CodexInstallation.CodexInstallation.layer,
    ),
  ),
);

const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
  Layer.provideMerge(layerPtyAdapter),
  Layer.provideMerge(AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer))),
  Layer.provideMerge(
    Layer.mergeAll(
      layerProviderEventLoggers,
      ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
      ResetCreditCoordinator.layer,
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
    ),
  ),
  Layer.provideMerge(
    OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(layerWorkspace),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, layerProjectFaviconResolver)),
  Layer.provideMerge(layerRepositoryIdentityResolver),
  Layer.provideMerge(CodexManagedTokenBroker.layer),
  Layer.provideMerge(layerServerEnvironment),
  Layer.provideMerge(layerAuth),
  Layer.provideMerge(AssetSigner.layer),
  Layer.provideMerge(ServerSecretStore.layer),
);

const layerRuntimeDependencies = layerRuntimeCoreDependencies.pipe(
  Layer.provideMerge(layerUsage),
  Layer.provideMerge(layerBackground),
  Layer.provideMerge(layerResourceDiagnostics),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(TriageService.layer.pipe(Layer.provide(GitVcsDriver.layer))),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(RemoteOpenTargets.layer),
  Layer.provideMerge(DirectEndpoints.layer.pipe(Layer.provide(layerServerEnvironment))),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  // GitVcsDriver.layer is memoized and some of its build sites live outside this file, so the
  // fetch interval goes in context here, before the first build captures it.
  Layer.provideMerge(VcsAutomaticFetchInterval.layer.pipe(Layer.provide(layerServerSettings))),
  Layer.provide(NetService.layer),
);

const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

const layerMakeRoutes = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(PullRequestHttp.layer),
      Layer.provide(UpdatePauseHttp.layer),
      Layer.provide(ProjectHttp.layer),
      Layer.provide(speechHttpApiLayer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(WebhookRoute.layer),
      Layer.provide(TailnetDevicesHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    ServerHttp.layerOtlpTracesProxyRoute,
    ServerHttp.layerAssetRoute,
    ServerHttp.layerAttachmentUploadRoute,
    DeviceHubProxy.layer,
    ServerBrowserStream.routeLayer,
    PreviewTunnel.routeLayer,
    ServerHttp.layerStaticAndDevRoute,
    Ws.layer,
    speechStreamRouteLayer,
  ),
  Layer.mergeAll(
    McpHttpServer.layer.pipe(
      Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
      Layer.provide(McpOAuth.layerMcpClientAuthenticator),
    ),
    // Fork: thread events reach T3 Agents webhooks without a desktop app.
    HeadlessGatewayHost.layerRuntime,
  ).pipe(
    // Fork: T3 Agents tools run against this server's own RPC API.
    Layer.provide(LocalGatewayPort.layer),
  ),
  // Follows delegated tasks running in linked environments, including after a restart.
  Layer.effectDiscard(
    RemoteDelegation.RemoteDelegation.pipe(Effect.flatMap((remote) => remote.start())),
  ),
  // Finds and links this user's other T3 servers on the tailnet.
  Layer.effectDiscard(
    TailnetDevices.TailnetDevices.pipe(Effect.flatMap((devices) => devices.start)),
  ),
).pipe(
  Layer.provide(
    PullRequestReviewGuideService.layer.pipe(Layer.provide(PullRequestReviewGuides.layer)),
  ),
  // delegate_task to a linked environment, from /mcp and the follower above.
  Layer.provide(RemoteDelegation.layer.pipe(Layer.provide(ProjectionStoreV2.layer))),
  // Links agents ask for: shown in a thread from /mcp, answered over WebSocket.
  Layer.provide(PeerLinkRequests.layer),
  // Share the service so HTTP/WS clients single-flight reads and invalidate each other's cached patches.
  Layer.provide(layerPullRequestService),
  Layer.provide(layerThreadIssueService),
  Layer.provide(layerIssueService),
  // The same activity instance RunExecutionService reports to, by layer memoization.
  Layer.provide(
    ServerBrowser.layer.pipe(
      Layer.provide(Layer.merge(DesktopBrowserChannel.layer, PreviewAgentActivity.layer)),
    ),
  ),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(PeerForwarding.layer.pipe(Layer.provideMerge(layerPeerLinks))),
  Layer.provide(
    SpeechService.layer.pipe(
      Layer.provide(layerServerSettings),
      Layer.provide(SpeechModelStore.layer),
    ),
  ),
  Layer.provide(CloudSpeech.layer.pipe(Layer.provide(SecretResolver.layer))),
  Layer.provide(layerServerSettings),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(ClientFocusBroker.layer),
  Layer.provide(layerMcpGatewayBroker),
  Layer.provide(ServerSelfUpdate.layer.pipe(Layer.provide(layerDesktopAppUpdate))),
  Layer.provide(layerCommandReadiness),
  Layer.provide(ServerHttp.layerBrowserApiCors),
  Layer.provide(ServerHttp.layerHttpCompression),
);

const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before anything opens the database: one server per T3 home.
    const ownership = yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath);
    // Forked beside the lock, so it runs while every other finalizer is still releasing.
    yield* (yield* ServerShutdown.ShutdownStarted).pipe(
      Effect.andThen(ownership.markStopping),
      Effect.ignore({ log: true }),
      Effect.forkScoped,
    );
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = Layer.succeed(ServerActivation.ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    // The port Serve published on, or null when it did not; the route check watches it.
    const tailscaleServePortChosen = yield* Deferred.make<number | null>();
    const routesReady = yield* Deferred.make<void>();
    const layerLauncher = ServiceLauncherClient.layer;

    // fixPath rewrites PATH, so pin the launcher the shell chose before it does.
    const invokedAs = (yield* resolveLauncherPath) ?? (yield* HostProcess.InvokedAs);
    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });
    // Before any layer below can spawn a child that would inherit them.
    const gatewayLauncherEnvironment = yield* HeadlessGatewayHost.takeLauncherEnvironment();

    const layerHttpListening = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const layerDesktopReadySignal = Layer.effectDiscard(
      Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
        yield* startup.awaitCommandReady.pipe(
          Effect.andThen(receiver.announceServerReady),
          Effect.ignore,
          Effect.forkScoped,
        );
        yield* receiver.pauseRequests.pipe(
          Stream.runForEach((requestId) =>
            startup.pauseRunsForUpdate.pipe(
              Effect.flatMap(({ pausedRuns }) => receiver.reportRunsPaused(requestId, pausedRuns)),
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to pause runs for desktop update", { cause }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
      }),
    );
    const layerRuntimeState = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
        yield* awaitActivation;
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return;
        }

        const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
        const state = yield* makePersistedServerRuntimeState({
          config,
          port: address.port,
          serviceManaged: launcher.managed,
          managedPolicy: yield* ManagedPolicy.loadedPolicy(yield* ManagedPolicy.ManagedPolicy),
        });
        yield* ownership
          .publish(state)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
      }),
    );
    const layerTailscaleServe = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              const localHost = loopbackUrlHostForAddress(address);
              // Another live server on a tailnet port (the machine's main T3,
              // say, when this one is a second instance) keeps its mapping:
              // replacing it cuts off every remote client reaching it.
              const choice = yield* chooseTailscaleServePort({
                pinnedPort: config.tailscaleServePort,
                stateDir: config.stateDir,
                localPort,
                localHost,
              }).pipe(Effect.option);
              if (Option.isNone(choice)) {
                yield* Effect.logWarning(
                  "Could not choose a Tailscale Serve port; not configuring Tailscale Serve",
                  { pinnedPort: config.tailscaleServePort, localPort },
                );
                return null;
              }
              const { servePort, ownership } = choice.value;
              if (ownership._tag === "taken") {
                yield* Effect.logWarning(
                  "Tailscale Serve port already forwards to another live server; leaving it alone",
                  { servePort, target: ownership.target, localPort },
                );
                return null;
              }
              const local = { localPort, servePort, localHost };
              return yield* ensureTailscaleServe(local).pipe(
                Effect.as({
                  ...local,
                  urlHost: localHost,
                  localHost: localHost.replace(/^\[|\]$/gu, ""),
                }),
                Effect.tap(() =>
                  Effect.all([
                    Deferred.succeed(tailscaleServePortChosen, servePort),
                    writeLastTailscaleServePort(config.stateDir, servePort).pipe(
                      Effect.ignore({ log: true }),
                    ),
                    Effect.logInfo(
                      `Published on your tailnet with Tailscale Serve (HTTPS port ${servePort}). Turn this off with --no-tailscale-serve or T3CODE_TAILSCALE_SERVE=false.`,
                      { localPort, servePort },
                    ),
                  ]),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning(
                    cause._tag === "TailscaleCommandExitError" &&
                      cause.stderrDiagnostic === "unsupported-target"
                      ? `Tailscale Serve left off; this Tailscale install can only proxy to localhost, not ${localHost}. Bind --host 127.0.0.1 or 0.0.0.0 instead`
                      : "Failed to configure Tailscale Serve",
                    { cause, localPort, servePort },
                  ).pipe(Effect.as(null)),
                ),
              );
            }).pipe(Effect.ensuring(Deferred.succeed(tailscaleServePortChosen, null))),
            (configured) =>
              configured
                ? Effect.all(
                    [
                      readTailscaleServeRoutesTo({
                        host: configured.localHost,
                        port: configured.localPort,
                      }),
                      readTailscaleStatus,
                    ],
                    { concurrency: 2 },
                  ).pipe(
                    // Another service may hold the root route by now, or it may sit under a
                    // former name, where `off` would act on the current one; only ours goes.
                    Effect.map(([routes, status]) =>
                      routes.some(
                        (route) =>
                          route.servePort === configured.servePort &&
                          route.mount === "/" &&
                          route.owner === undefined &&
                          route.ambiguous === undefined &&
                          route.host?.toLowerCase() === status.magicDnsName?.toLowerCase(),
                      ),
                    ),
                    Effect.orElseSucceed(() => false),
                    Effect.flatMap((ours) =>
                      ours
                        ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                            Effect.tap(() =>
                              Effect.logInfo("Tailscale Serve disabled", {
                                servePort: configured.servePort,
                              }),
                            ),
                          )
                        : Effect.logInfo(
                            "Tailscale Serve left on; its root route is not known to be ours",
                            {
                              servePort: configured.servePort,
                            },
                          ),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ).pipe(
            // Startup is not the only time the route can go stale, so whoever finds it on a dead
            // port takes it back.
            Effect.tap((configured) =>
              configured === null
                ? Effect.void
                : Effect.sleep("30 seconds").pipe(
                    Effect.andThen(
                      readTailscaleServeRootHolder(configured.servePort, {
                        host: configured.localHost,
                        port: configured.localPort,
                      }),
                    ),
                    Effect.flatMap((holder) =>
                      holder === "dead"
                        ? ensureTailscaleServe({
                            localPort: configured.localPort,
                            servePort: configured.servePort,
                            localHost: configured.urlHost,
                          }).pipe(
                            Effect.andThen(
                              Effect.logInfo("Tailscale Serve repaired", {
                                localPort: configured.localPort,
                                servePort: configured.servePort,
                              }),
                            ),
                          )
                        : Effect.void,
                    ),
                    Effect.ignore,
                    Effect.forever,
                    Effect.forkScoped,
                  ),
            ),
          ),
        ).pipe(Layer.provide(NetService.layer))
      : Layer.empty;
    // Dev servers never own the machine's tailnet route, so only a production
    // server reports when that route stops reaching it.
    const layerTailnetRouteCheck =
      config.devUrl === undefined
        ? Layer.effectDiscard(
            Effect.gen(function* () {
              const address = (yield* HttpServer.HttpServer).address;
              if (typeof address === "string" || !("port" in address)) return;
              const environment = yield* ServerEnvironment.ServerEnvironment;
              yield* Effect.gen(function* () {
                yield* awaitActivation;
                const environmentId = yield* environment.getEnvironmentId;
                const chosenPort = config.tailscaleServeEnabled
                  ? yield* Deferred.await(tailscaleServePortChosen)
                  : null;
                const servePort =
                  chosenPort ??
                  (yield* expectedTailscaleServePort({
                    pinnedPort: config.tailscaleServePort,
                    stateDir: config.stateDir,
                  }));
                return yield* watchTailnetRoute({
                  servePort,
                  localPort: address.port,
                  environmentId,
                });
              }).pipe(Effect.forkScoped);
            }),
          )
        : Layer.empty;
    // Clears what T3 Connect left on this machine, after any older server has handed over.
    const layerConnectTeardown = Layer.effectDiscard(
      ServerActivation.forkParked(
        ConnectTeardown.ConnectTeardown.pipe(Effect.flatMap((teardown) => teardown.run())),
      ),
    ).pipe(Layer.provide(ConnectTeardown.layer));

    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(
      // One instance for the settings RPCs and the gateway runtime the routes start.
      Layer.provideMerge(
        HeadlessGatewayHost.layer.pipe(
          Layer.provide(
            Layer.succeed(HeadlessGatewayHost.LauncherEnvironment, gatewayLauncherEnvironment),
          ),
        ),
      ),
      Layer.provideMerge(layerRuntimeDependencies),
      Layer.provide(layerLauncher),
    );

    const layerRoutes = HttpRouter.serve(layerMakeRoutes.pipe(Layer.provide(layerLauncher)), {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      withUntracedRequests,
      withRootRequestSpans,
      Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)),
    );
    const layerServerApplication = Layer.mergeAll(
      layerRoutes,
      layerHttpListening,
      layerDesktopReadySignal,
      layerRuntimeState.pipe(Layer.provide(layerLauncher)),
      layerTailscaleServe,
      layerTailnetRouteCheck,
      layerConnectTeardown,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      Layer.provideMerge(
        ServerRuntimeStartup.layerUpdatePause.pipe(Layer.provideMerge(layerRuntimeServices)),
      ),
      Layer.provideMerge(
        McpSessionRegistry.layer.pipe(
          Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        ),
      ),
      Layer.provide(layerActivation),
      Layer.provideMerge(layerHttpServer),
      Layer.provide(layerApplicationObservability),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(AgentTempDirLive.layer),
      Layer.provideMerge(layerPlatformServices),
      Layer.provide(Layer.succeed(HostProcess.InvokedAs, invokedAs)),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer));

export const runServer = Layer.launch(
  // For the layers above whose spawner requirement is not met by one of them.
  layerMakeServer.pipe(Layer.provide(NonBlockingSpawner.layer.pipe(Layer.provide(layerSpawner)))),
);
