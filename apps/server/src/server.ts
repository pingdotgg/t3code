import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { installAgentCliEnvironment } from "./cli/agentEnvironment.ts";
import { ServerStartupClaimLive } from "./serverStartupClaim.ts";
import { timeStartupLayer } from "./startupTiming.ts";
import {
  assetRouteLayer,
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
} from "./http.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import { OpenLive } from "./open.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { GitActivityLedgerLive } from "./persistence/Layers/GitActivityLedger.ts";
import { ProjectionThreadPullRequestRepositoryLive } from "./persistence/Layers/ProjectionThreadPullRequests.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime.ts";
import { ProjectionWorkflowRepositoryLive } from "./persistence/Layers/ProjectionWorkflows.ts";
import { ProviderEventLoggersLive } from "./provider/Layers/ProviderEventLoggers.ts";
import { layer as providerLogRetentionLayer } from "./provider/Layers/ProviderLogRetention.ts";
import { ProviderRuntimeLivenessLive } from "./provider/Layers/ProviderRuntimeLiveness.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { OpenCodeRuntimeLive } from "./provider/opencodeRuntime.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import { DiffStateQueryLive } from "./diffState/Layers/DiffStateQuery.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitHubCliLive } from "./git/Layers/GitHubCli.ts";
import { GitStatusBroadcasterLive } from "./git/Layers/GitStatusBroadcaster.ts";
import { ProjectAutoPullLive } from "./git/ProjectAutoPull.ts";
import { TextGenerationLive } from "./git/Layers/TextGenerationLive.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import { GitManagerLive } from "./git/Layers/GitManager.ts";
import { KeybindingsLive } from "./keybindings.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";
import { layer as automaticArchiveGuardRegistryLayer } from "./orchestration/Services/AutomaticArchiveGuardRegistry.ts";
import { layer as settledAutoArchiveReactorLayer } from "./orchestration/Layers/SettledAutoArchiveReactor.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { TurnLifecycleRuntimeLayerLive } from "./orchestration/Layers/TurnLifecycleRuntime.ts";
import { ThreadTitleReactorLive } from "./orchestration/Layers/ThreadTitleReactor.ts";
import { QueuedTurnReactorLive } from "./orchestration/Layers/QueuedTurnReactor.ts";
import { WorkflowCoordinatorReactorLive } from "./orchestration/Layers/WorkflowCoordinatorReactor.ts";
import { ValidationCoordinatorReactorLive } from "./orchestration/Layers/ValidationCoordinatorReactor.ts";
import { RepositoryValidationRunnerLive } from "./validation/RepositoryValidationRunner.ts";
import {
  ValidationArtifactStoreService,
  makeFileValidationArtifactStore,
} from "./validation/RepositoryValidationRunner.ts";
import { ValidationEnvironmentServiceLive } from "./validation/ValidationEnvironmentService.ts";
import { ValidationGateExecutorLive } from "./validation/ValidationGateExecutor.ts";
import {
  ValidationCoordinatorTargetResolverLive,
  ValidationLifecycleLive,
} from "./validation/ValidationLifecycle.ts";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService.ts";
import { ReviewSnapshotVerifierLive } from "./orchestration/Layers/ReviewSnapshotVerifier.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { SidebarStateLive } from "./sidebarState.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment.ts";
import {
  authAccessTokenRouteLayer,
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  environmentAuthenticatedAuthLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authPreviewAttestationRouteLayer,
  authPreviewBootstrapRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
  authWebSocketTicketRouteLayer,
} from "./auth/http.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import { ManagedPreviewAuthLive } from "./auth/Layers/ManagedPreviewAuth.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./auth/Layers/AuthControlPlane.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { CheckoutCoordinatorLive } from "./git/CheckoutCoordinator.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationShellSnapshotRouteLayer,
  orchestrationSnapshotRouteLayer,
  orchestrationThreadSnapshotRouteLayer,
  orchestrationThreadReadRouteLayer,
  worktreeCleanupInventoryRouteLayer,
  worktreeCleanupKeepRouteLayer,
  worktreeCleanupRetryRouteLayer,
} from "./orchestration/http.ts";
import { NetService } from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { mobileRouteLayer } from "./mobileProtocol.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as CloudEnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as CloudServerSecretStore from "./auth/ServerSecretStore.ts";
import * as CliTokenManager from "./cloud/CliTokenManager.ts";
import * as ManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as RemoteAccess from "./remoteAccess/RemoteAccess.ts";
import * as ServerAdvertisedEndpoints from "./remoteAccess/ServerAdvertisedEndpoints.ts";
import { routes as remoteAccessRoutes } from "./remoteAccess/http.ts";
import { connectHttpApiRoutesLayer } from "./cloud/http.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { pullRequestHttpApiRoutesLayer } from "./pullRequest/http.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import { layer as PullRequestProviderRegistryLive } from "./pullRequest/PullRequestProviderRegistry.ts";
import { layer as PullRequestServiceLive } from "./pullRequest/PullRequestService.ts";
import { GitHubApiUsagePersistentLive } from "./gitHubUsage/GitHubApiUsage.ts";
import { layer as pullRequestMonitorFeedbackServiceLayer } from "./pullRequestMonitor/PullRequestMonitorFeedbackService.ts";
import { layer as pullRequestMonitorAssociationReactorLayer } from "./pullRequestMonitor/PullRequestMonitorAssociationReactor.ts";
import { layer as pullRequestAssociationRecoveryLayer } from "./pullRequestMonitor/PullRequestAssociationRecovery.ts";
import { PullRequestCreationAutomationLive } from "./pullRequestMonitor/PullRequestCreationAutomation.ts";
import { layer as pullRequestMonitorReviewHandoffReactorLayer } from "./pullRequestMonitor/PullRequestReviewHandoffReactor.ts";
import { layer as createdPullRequestReviewReactorLayer } from "./pullRequestMonitor/CreatedPullRequestReviewReactor.ts";
import { layer as reviewThreadMergeArchiveReactorLayer } from "./pullRequestMonitor/ReviewThreadMergeArchiveReactor.ts";
import { ProjectionStateRepositoryLive } from "./persistence/Layers/ProjectionState.ts";
import { ServerShutdownMarkerRepositoryLive } from "./persistence/Layers/ServerShutdownMarker.ts";
import { PullRequestCreationIntentRepositoryLive } from "./persistence/Layers/PullRequestCreationIntents.ts";
import { CollaborativeAcceptanceRepositoryLive } from "./persistence/Layers/CollaborativeAcceptance.ts";
import { CollaborativeAcceptanceCoordinatorLive } from "./collaborativeAcceptance/Coordinator.ts";
import { layer as pullRequestMonitorServiceLayer } from "./pullRequestMonitor/PullRequestMonitorService.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";
import * as ProcessRunner from "./processRunner.ts";

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY.ts"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY.ts"));
      return NodePTY.layer;
    }
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all(
        [
          Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
          Effect.promise(() => import("node:http")),
        ],
        { concurrency: "unbounded" },
      );
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ValidationArtifactStoreLive = Layer.effect(
  ValidationArtifactStoreService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const { join } = yield* Effect.promise(() => import("node:path"));
    return makeFileValidationArtifactStore(join(config.baseDir, "validation", "artifacts"));
  }),
);

const ValidationGateExecutorWiredLive = ValidationGateExecutorLive.pipe(
  Layer.provide(
    RepositoryValidationRunnerLive.pipe(
      Layer.provide(ProcessRunner.layer),
      Layer.provide(ValidationArtifactStoreLive),
    ),
  ),
  Layer.provide(ValidationEnvironmentServiceLive),
  Layer.provide(BootstrapCredentialServiceLive),
);

const ValidationLifecycleWiredLive = ValidationLifecycleLive.pipe(
  Layer.provideMerge(ValidationCoordinatorTargetResolverLive),
  Layer.provide(ValidationGateExecutorWiredLive),
);

const ValidationCoordinatorWiredLive = ValidationCoordinatorReactorLive.pipe(
  Layer.provide(ValidationLifecycleWiredLive),
);
// Same guard-registry instance the engine reads (Effect layer memoization
// shares it with reviewThreadMergeArchiveLayerLive below), so the settled
// admission guard and the merge admission guard are consulted together.
const settledAutoArchiveLayerLive = settledAutoArchiveReactorLayer.pipe(
  Layer.provide(automaticArchiveGuardRegistryLayer),
);
const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(TurnLifecycleRuntimeLayerLive),
  Layer.provideMerge(ThreadTitleReactorLive),
  Layer.provideMerge(QueuedTurnReactorLive),
  Layer.provideMerge(WorkflowCoordinatorReactorLive),
  Layer.provideMerge(ValidationCoordinatorWiredLive),
  Layer.provideMerge(ReviewSnapshotVerifierLive),
  Layer.provideMerge(ProjectionWorkflowRepositoryLive),
  Layer.provideMerge(ServerShutdownMarkerRepositoryLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(providerLogRetentionLayer),
  Layer.provideMerge(RuntimeReceiptBusLive),
  Layer.provideMerge(createdPullRequestReviewReactorLayer),
  Layer.provideMerge(settledAutoArchiveLayerLive),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(DiffStateQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

// Adapter construction lives inside each provider driver's `create()`;
// `ProviderService` reads those adapters directly from the instance registry.
// `ProviderEventLoggersLive` owns the shared native/canonical NDJSON writers
// and is provided at the outer runtime layer so both consumers share them.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

export const PersistenceLayerLive = PullRequestCreationIntentRepositoryLive.pipe(
  Layer.provideMerge(ServerShutdownMarkerRepositoryLive),
  Layer.provideMerge(CollaborativeAcceptanceRepositoryLive),
  Layer.provideMerge(
    GitActivityLedgerLive.pipe(Layer.provideMerge(ProjectionThreadPullRequestRepositoryLive)),
  ),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const GitManagerLayerLive = GitManagerLive.pipe(
  Layer.provideMerge(ProjectSetupScriptRunnerLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(TextGenerationLive),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(
    GitStatusBroadcasterLive.pipe(
      Layer.provide(GitManagerLayerLive),
      Layer.provideMerge(
        ProjectAutoPullLive.pipe(Layer.provide(GitCoreLive), Layer.provide(OrchestrationLayerLive)),
      ),
    ),
  ),
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
);

const PullRequestLayerLive = PullRequestServiceLive.pipe(
  Layer.provideMerge(PullRequestProviderRegistryLive),
  Layer.provideMerge(PullRequestReadCache.layer),
  Layer.provideMerge(GitHubApiUsagePersistentLive),
);

const PullRequestMonitorFeedbackServiceLive = pullRequestMonitorFeedbackServiceLayer.pipe(
  Layer.provide(PullRequestLayerLive),
);

const PullRequestMonitorServiceLive = pullRequestMonitorServiceLayer.pipe(
  Layer.provide(PullRequestLayerLive),
  Layer.provideMerge(PullRequestMonitorFeedbackServiceLive),
  Layer.provideMerge(GitManagerLayerLive),
);

const PullRequestAssociationRecoveryLayerLive = pullRequestAssociationRecoveryLayer.pipe(
  Layer.provideMerge(PullRequestCreationAutomationLive),
);

// Layer memoization keeps this on the same pull request service and guard registry as the rest of
// the runtime.
const reviewThreadMergeArchiveLayerLive = reviewThreadMergeArchiveReactorLayer.pipe(
  Layer.provide(PullRequestLayerLive),
  Layer.provide(automaticArchiveGuardRegistryLayer),
);

// Associating a pull request with a chat is the ownership signal, so monitoring follows it.
// provideMerge keeps one monitor service instance shared with the reactor.
const PullRequestMonitorLayerLive = pullRequestMonitorAssociationReactorLayer.pipe(
  Layer.provideMerge(PullRequestAssociationRecoveryLayerLive),
  Layer.provideMerge(reviewThreadMergeArchiveLayerLive),
  Layer.provideMerge(pullRequestMonitorReviewHandoffReactorLayer),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  Layer.provideMerge(PullRequestMonitorServiceLive),
);

// The MCP credential registry and the automation broker are runtime services:
// the websocket RPC handlers and the HTTP MCP endpoint must resolve the same
// instances so a provider-scoped tool call reaches the registered browser host.
const PreviewAutomationLayerLive = Layer.mergeAll(
  PreviewAutomationBroker.layer,
  McpSessionRegistry.layer,
).pipe(Layer.provideMerge(ManagedPreviewAuthLive));

const TerminalLayerLive = Layer.mergeAll(
  TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive)),
  PreviewManager.layer,
  PortScanner.layer,
);

const DeviceLayerLive = DeviceService.layer.pipe(
  Layer.provide(ServerSettingsLive),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

const WorkspaceEntriesLayerLive = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
);

const WorkspaceFileSystemLayerLive = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const AuthLayerLive = ServerAuthLive.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  // provideMerge so ws/routes that transitively need the store still see it
  // once WsRpcGroup.of typechecks fully (the old @ts-expect-error masked this).
  Layer.provideMerge(ServerSecretStoreLive),
);

const AuthControlPlaneLayerLive = AuthControlPlaneLive.pipe(
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(ServerSecretStoreLive),
);

const CloudEnvironmentAuthLayerLive = CloudEnvironmentAuth.runtimeLayer.pipe(
  Layer.provide(AuthControlPlaneLayerLive),
);

const CloudRelayClientLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return RelayClient.layerCloudflared({
      baseDir: config.baseDir,
    }) as Layer.Layer<RelayClient.RelayClient>;
  }),
);

type CloudRuntimeServices =
  | CloudServerSecretStore.ServerSecretStore
  | CloudEnvironmentAuth.EnvironmentAuth
  | CliTokenManager.CloudCliTokenManager
  | RelayClient.RelayClient
  | ManagedEndpointRuntime.CloudManagedEndpointRuntime
  | AgentAwarenessRelay.AgentAwarenessRelay;

type CloudHttpRuntimeServices = Exclude<
  CloudRuntimeServices,
  AgentAwarenessRelay.AgentAwarenessRelay
>;

const CloudBaseLayerLive = Layer.mergeAll(
  CloudServerSecretStore.layer,
  CloudEnvironmentAuthLayerLive,
  CloudRelayClientLayerLive,
);

export const RemoteAccessLayerLive = RemoteAccess.layer.pipe(
  Layer.provide(CloudBaseLayerLive),
  Layer.provide(ServerEnvironmentLive),
);

const AgentAwarenessRelayLayerLive = AgentAwarenessRelay.layer.pipe(
  Layer.provide(CloudBaseLayerLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(CheckoutCoordinatorLive),
);

export const CloudHttpRuntimeLayerLive = Layer.mergeAll(
  CloudBaseLayerLive,
  CliTokenManager.layer.pipe(Layer.provide(CloudBaseLayerLive)),
  ManagedEndpointRuntime.layer.pipe(Layer.provide(CloudBaseLayerLive)),
) as unknown as Layer.Layer<CloudHttpRuntimeServices>;

const CloudRuntimeServicesLayerLive = AgentAwarenessRelayLayerLive.pipe(
  Layer.provideMerge(CloudHttpRuntimeLayerLive),
);

export const CloudRuntimeLayerLive = Layer.effectDiscard(
  Effect.logInfo("cloud-runtime-ready"),
).pipe(
  Layer.provideMerge(CloudRuntimeServicesLayerLive),
) as unknown as Layer.Layer<CloudRuntimeServices>;

const ConnectHttpApiRoutesLayerLive = connectHttpApiRoutesLayer as unknown as Layer.Layer<never>;
const RemoteAccessRoutesLayerLive = remoteAccessRoutes as unknown as Layer.Layer<never>;

const BackgroundLayerLive = BackgroundPolicy.layer.pipe(Layer.provideMerge(HostPowerMonitor.layer));

const AcceptanceOrchestrationLayerLive = OrchestrationLayerLive.pipe(
  Layer.provideMerge(CollaborativeAcceptanceCoordinatorLive),
);

const ProviderRuntimeSharedLayersLive = Layer.mergeAll(
  ProviderEventLoggersLive,
  ProviderRuntimeLivenessLive,
);

const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(PullRequestLayerLive),
  Layer.provideMerge(PullRequestMonitorLayerLive),
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(AcceptanceOrchestrationLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
  // Shared provider runtime singletons. Both are provided once at the runtime
  // level so every consumer sees the same instances.
  //
  // `ProviderEventLoggersLive` owns the native/canonical NDJSON writers used by
  // the per-instance drivers (written from inside each `<X>Adapter`) and by
  // `ProviderService` (canonical stream, written after event normalization).
  //
  // `ProviderRuntimeLivenessLive` records what the provider runtime has
  // observed per thread ahead of the durable projection. `ProviderService`
  // writes it on the runtime-event funnel and `ProviderSessionReaper` reads it
  // to tell a genuinely lost session apart from a terminal event still queued
  // for the projection.
  Layer.provideMerge(ProviderRuntimeSharedLayersLive),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntimeLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(DeviceLayerLive),
  Layer.provideMerge(BackgroundLayerLive),
  Layer.provideMerge(SidebarStateLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
).pipe(
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(PreviewAutomationLayerLive),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(CloudRuntimeLayerLive),
  Layer.provideMerge(RemoteAccessLayerLive),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provide(NetService.layer),
);

// Deep Layer pipes lose `ServerEnvironment` from R even though
// RuntimeCoreDependenciesLive provideMerges it. Re-provide here and narrow
// only this sublayer's input so makeServerLayer stays ServerConfig-checked
// without a whole-graph assertion.
const RuntimeServicesLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
  Layer.provideMerge(ServerEnvironmentLive),
) as Layer.Layer<
  Layer.Success<typeof ServerRuntimeStartupLive> | Layer.Success<typeof RuntimeDependenciesLive>,
  Layer.Error<typeof ServerRuntimeStartupLive> | Layer.Error<typeof RuntimeDependenciesLive>,
  ServerConfig
>;

export const makeRoutesLayer = Layer.mergeAll(
  authAccessTokenRouteLayer,
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authPreviewAttestationRouteLayer,
  authPreviewBootstrapRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
  authWebSocketTicketRouteLayer,
  assetRouteLayer,
  attachmentsRouteLayer,
  orchestrationDispatchRouteLayer,
  orchestrationShellSnapshotRouteLayer,
  orchestrationSnapshotRouteLayer,
  orchestrationThreadSnapshotRouteLayer,
  orchestrationThreadReadRouteLayer,
  worktreeCleanupInventoryRouteLayer,
  worktreeCleanupKeepRouteLayer,
  worktreeCleanupRetryRouteLayer,
  pullRequestHttpApiRoutesLayer,
  ConnectHttpApiRoutesLayerLive,
  RemoteAccessRoutesLayerLive,
  mobileRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer.pipe(Layer.provide(DeviceLayerLive)),
  deviceHubProxyRouteLayer.pipe(Layer.provide(DeviceLayerLive)),
  McpHttpServer.layer,
  McpHttpServer.layerWithDevice.pipe(Layer.provide(DeviceLayerLive)),
).pipe(Layer.provideMerge(environmentAuthenticatedAuthLayer), Layer.provide(browserApiCorsLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();
    yield* installAgentCliEnvironment(config.baseDir, config.baseDir);

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const state = makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          });
          const serviceRuntimeStatePath = process.env.T3CODE_SERVICE_RUNTIME_STATE_PATH;
          if (serviceRuntimeStatePath) {
            yield* persistServerRuntimeState({
              path: serviceRuntimeStatePath,
              state,
            });
          }
        }),
        () =>
          Effect.gen(function* () {
            yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
            const serviceRuntimeStatePath = process.env.T3CODE_SERVICE_RUNTIME_STATE_PATH;
            if (serviceRuntimeStatePath) {
              yield* clearPersistedServerRuntimeState(serviceRuntimeStatePath);
            }
          }),
      ),
    );

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
      runtimeStateLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provide(ServerAdvertisedEndpoints.layer),
      Layer.provideMerge(timeStartupLayer("runtime.services", RuntimeServicesLive)),
      Layer.provideMerge(DeviceLayerLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(ServerStartupClaimLive),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
