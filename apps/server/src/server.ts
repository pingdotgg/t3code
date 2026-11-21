// @effect-diagnostics nodeBuiltinImport:off - Plugin preference bootstrap runs before platform services are registered.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  builtinContextLayer,
  builtinSucceedLayer,
  builtinLifecycleLayer,
  layerWithEnabled,
} from "@t3tools/shared/pluginKernel";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Random from "effect/Random";
import * as EnvironmentKeys from "./cloud/environmentKeys.ts";
import * as AssetSigner from "./assets/AssetSigner.ts";
import * as WorkspacePreviewRevisions from "./assets/WorkspacePreviewRevisions.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginError, EnvironmentHttpApi } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

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
import { resolveLauncherPath } from "./cloud/pinnedRuntime.ts";
import { fixPath } from "./os-jank.ts";
import * as Ws from "./ws.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as SpawnWorker from "./process/SpawnWorker.ts";
import * as SpeechModelStore from "./speech/SpeechModelStore.ts";
import * as SpeechService from "./speech/SpeechService.ts";
import * as CloudSpeech from "./speech/CloudSpeech.ts";
import { speechHttpApiLayer } from "./speech/http.ts";
import { speechStreamRouteLayer } from "./speech/stream.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as IssueTrackerConnections from "./issue/IssueTrackerConnections.ts";
import * as IssueTrackerBindings from "./persistence/IssueTrackerBindings.ts";
import * as IssueTrackerRegistry from "./issue/IssueTrackerRegistry.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./telemetry/DelegatedTaskAnalytics.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import * as SecretResolver from "./secrets/SecretResolver.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as PeerForwarding from "./peer/PeerForwarding.ts";
import * as RemoteDelegation from "./peer/RemoteDelegation.ts";
import * as PeerClientPairing from "./peer/PeerClientPairing.ts";
import * as PeerClientPairingHttp from "./peer/http.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerMcpClient from "./peer/PeerMcpClient.ts";
import * as PeerThreadRelay from "./peer/PeerThreadRelay.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import * as ManagedLimits from "./policy/managedLimits.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as ProviderInstallationGate from "./provider/ProviderInstallationGate.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsAutomaticFetchInterval from "./vcs/VcsAutomaticFetchInterval.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as CodexManagedTokenBroker from "./provider/CodexManagedTokenBroker.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as RelayDeliveryProof from "./scheduledTasks/RelayDeliveryProof.ts";
import * as HeldHooksWaker from "./relay/HeldHooksWaker.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentAuthPolicy from "./auth/EnvironmentAuthPolicy.ts";
import * as CloudHttp from "./cloud/http.ts";
import * as GuestHttp from "./guest/http.ts";
import * as LinkThreadHttp from "./peer/linkThreadHttp.ts";
import * as CloudLink from "./cloud/CloudLink.ts";
import * as ConnectReachability from "./cloud/ConnectReachability.ts";
import { pendingServiceUpdateExists } from "./cloud/updateHandoff.ts";
import * as RelayTracing from "./cloud/relayTracing.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as RelayClientLedger from "./cloud/RelayClientLedger.ts";
import {
  MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER,
  makeManagedTunnelRecovery,
  managedTunnelStartupAction,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
  watchManagedTunnelOrigin,
} from "./cloud/managedTunnelStartup.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudCliState from "./cloud/CliState.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as IdleCompactionService from "./orchestration-v2/IdleCompactionService.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import { makePersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { closeNonPrivateNetworkConnections, loopbackUrlHostForAddress } from "./startupAccess.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeRootHolder,
  readTailscaleServeRoutesTo,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as ServerActivation from "./serverActivation.ts";
import * as Plugins from "./plugins/PluginService.ts";
import * as PluginCatalog from "./plugins/PluginCatalog.ts";
import { ProviderDriverCatalogLive } from "./provider/ProviderDriverCatalog.ts";
import { pluginAssetRouteLayer, pluginHttpRouteLayer } from "./plugins/http.ts";
import { layerServerSettings, layerPersistence } from "./plugins/builtin/settings.ts";
import {
  layerApplicationObservability,
  layerDesktopAppUpdate,
  layerBackground,
  layerResourceDiagnostics,
} from "./plugins/builtin/resources.ts";
import {
  layerUsage,
  layerUsageLimitsIngestion,
  layerUsageLimitSources,
} from "./plugins/builtin/usage.ts";
import {
  layerSourceControlProviderRegistry,
  layerRepositoryIdentityResolver,
  layerPullRequestService,
  layerGit,
  layerVcs,
  layerPullRequestHttp,
  layerPullRequestReviewGuideService,
} from "./plugins/builtin/sourceControl.ts";
import {
  layerPortScanner,
  layerPreview,
  layerDevice,
  layerServerBrowser,
  layerPreviewBrowser,
  layerPreviewAutomationBroker,
  layerDeviceHubProxy,
  layerBrowserStreamRoute,
  layerPreviewTunnelRoute,
} from "./plugins/builtin/preview.ts";
import { layerPtyAdapter, layerTerminal } from "./plugins/builtin/terminal.ts";
import { CanvasLayerLive } from "./plugins/builtin/canvas.ts";
import {
  layerWorkspace,
  layerProjectEnrichment,
  layerProjectAssets,
  layerProjectHttp,
} from "./plugins/builtin/workspace.ts";
import {
  layerProviderInstallationRefresh,
  layerProviderRegistry,
  layerProviderInstanceRegistryHydration,
  layerProviderInstallations,
  layerAcpRegistrySupport,
  layerProviderRuntimeServices,
  layerOpenCodeRuntime,
  layerProviderAdapterRegistry,
} from "./plugins/builtin/providers.ts";
import {
  layerOrchestrationApplication,
  layerPluginEventSink,
  layerThreadSettlementWorker,
  layerThreadPullRequestWorker,
  layerStorageCleanup,
  layerPullRequestSyncWorker,
  layerPullRequestWatchWorker,
  layerProjectSettingsOverrideSweep,
  layerEventInfrastructure,
  layerProjectStoreAndSearch,
  layerTaskFolders,
} from "./plugins/builtin/threads.ts";

// Escaped MCP handoff provenance can exceed find-my-way's 100-character segment default.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Skip Effect's default 20 s grace; WebSocket scope finalizers already close connections gracefully.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const layerRelayClient = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const policy = yield* ManagedPolicy.ManagedPolicy;
    const layerCloudflared = RelayClient.layerCloudflared({ baseDir: config.baseDir });
    if (ManagedLimits.allowsConnect(policy)) return layerCloudflared;
    // The connector only carries T3 Connect, so a policy without Connect never installs one.
    const refused = Effect.fn("RelayClient.installRefusedByPolicy")(function* () {
      return yield* new RelayClient.RelayClientInstallError({
        reason: "managed_by_policy",
        message: ManagedLimits.refuseConnect(policy).message,
      });
    });
    return Layer.effect(
      RelayClient.RelayClient,
      Effect.gen(function* () {
        const relayClient = yield* RelayClient.RelayClient;
        return RelayClient.RelayClient.of({
          ...relayClient,
          install: refused(),
          installWithProgress: refused,
        });
      }),
    ).pipe(Layer.provide(layerCloudflared));
  }),
).pipe(Layer.provide(ManagedPolicy.layer));

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
    return builtinContextLayer(
      "t3.http",
      Layer.build(
        NodeHttpServer.layer(
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
        ).pipe(Layer.merge(layerSpawner)),
      ),
    );
  }),
).pipe(
  Layer.provide(ManagedPolicy.layer),
  // NodeHttpServer.layer also outputs NodeServices, whose spawner would shadow the wrapped one.
  (layer) => NonBlockingSpawner.layer.pipe(Layer.provideMerge(layer)),
);

const layerPlatformServices = builtinContextLayer(
  "t3.server",
  Layer.build(
    DocumentText.layer.pipe(
      Layer.provideMerge(NonBlockingSpawner.layer),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerSpawner)),
    ),
  ),
);

// Both read the one registry, so a standalone tracker connected in Settings is the same
// instance the listing reads through.
const layerIssueService = Layer.merge(IssueService.layer, IssueTrackerConnections.layer).pipe(
  Layer.provide(Layer.merge(IssueTrackerRegistry.layer, IssueTrackerBindings.layer)),
);

// One instance serves MCP link calls and refreshes snapshots on thread events.
const layerThreadIssueService = ThreadIssueService.layer;

const layerServerEnvironment = ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(layerPersistence),
  Layer.provide(layerServerEnvironment),
  Layer.provide(ServerSecretStore.layer),
);

const layerCloudManagedEndpointRuntime = Layer.mergeAll(
  layerRelayClient,
  CloudManagedEndpointRuntime.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerRelayClient),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return RelayClientLedger.layer({ stateDir: config.stateDir });
        }),
      ),
    ),
  ),
);

const layerIdleCompactionWorker = builtinLifecycleLayer(
  "t3.thread",
  "t3/server/root/idle-compaction",
  IdleCompactionService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(ProjectionStoreV2.layer));

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
  AgentAwarenessRelay.layer,
  HeldHooksWaker.layer,
  layerThreadSettlementWorker,
  layerIdleCompactionWorker,
  // Needs ProjectService (orchestration) and WorkspacePaths, provided below.
  CanvasLayerLive,
  layerStorageCleanup,
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(layerServerRestart),
  ),
  layerThreadPullRequestWorker,
  KeepAwake.layer,
  DelegatedTaskAnalytics.layer,
  layerPullRequestSyncWorker,
  layerPullRequestWatchWorker,
  builtinLifecycleLayer(
    "t3.thread",
    "t3/server/root/delegated-task-questions",
    Effect.gen(function* () {
      const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      yield* service.start();
    }),
  ).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(ProjectionStoreV2.layer)),
  layerUsageLimitsIngestion,
  layerProviderInstallationRefresh,
  ProviderInstallation.layer,
  ReplayMarkers.layer,
  layerProjectSettingsOverrideSweep,
).pipe(
  Layer.provideMerge(layerOrchestrationApplication),
  Layer.provideMerge(layerTaskFolders),
  Layer.provideMerge(layerEventInfrastructure),
  Layer.provideMerge(layerProjectStoreAndSearch),
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
  Layer.provideMerge(Layer.mergeAll(Keybindings.layer, layerUsageLimitSources)),
  Layer.provideMerge(layerProviderRegistry),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // hydration adds their default instances to `providerInstances` on boot.
  Layer.provideMerge(layerProviderInstanceRegistryHydration),
  // One gate for the server, below hydration so the Claude adapter sees it: layers memoize by
  // reference, so the runtime layer shares it.
  Layer.provideMerge(ProviderInstallationGate.layer),
  // Provider hydration builds the Claude runner, which reports agents to the same scanner the
  // terminal and preview layers share.
  Layer.provideMerge(layerPortScanner),
  Layer.provideMerge(layerProviderInstallations),
);

const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
  Layer.provideMerge(layerPtyAdapter),
  // Search, prepare, status inspection, and turn launch share one registry
  // cache so every client and provider instance sees the same prepared agents.
  Layer.provideMerge(layerAcpRegistrySupport),
  // Share event loggers across drivers and orchestration; ModelCatalog exposes
  // the model manifest refreshed from main's model-manifest.json.
  Layer.provideMerge(layerProviderRuntimeServices),
  // Drivers need OpenCodeRuntime directly; share one instance across its consumers.
  Layer.provideMerge(layerOpenCodeRuntime),
  Layer.provideMerge(layerWorkspace),
  Layer.provideMerge(layerProjectEnrichment),
  Layer.provideMerge(layerProjectAssets),
  Layer.provideMerge(layerRepositoryIdentityResolver),
  Layer.provideMerge(CodexManagedTokenBroker.layer),
  Layer.provideMerge(layerServerEnvironment),
  Layer.provideMerge(layerAuth),
  Layer.provideMerge(
    Layer.mergeAll(AssetSigner.layer, EnvironmentKeys.layer, WorkspacePreviewRevisions.layer),
  ),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudCliTokenManager.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ExternalLauncher.layer),
      ),
      layerCloudManagedEndpointRuntime,
    ),
  ),
);

const layerRuntimeDependencies = Plugins.eventsLayer.pipe(
  Layer.provide(layerPluginEventSink),
  Layer.provideMerge(layerRuntimeCoreDependencies),
  Layer.provideMerge(Plugins.layer),
  Layer.provideMerge(PluginCatalog.layer),
  Layer.provideMerge(ProviderDriverCatalogLive),
  Layer.provideMerge(layerUsage),
  Layer.provideMerge(layerBackground),
  // The same layer the event sink uses; memoized, subscriptions and batch ranking share it.
  Layer.provideMerge(ThreadViewers.layer),
  Layer.provideMerge(layerResourceDiagnostics),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(TriageService.layer.pipe(Layer.provide(GitVcsDriver.layer))),
  // Layers memoize by reference, so this is the same policy the settings layer reads.
  Layer.provideMerge(AnalyticsService.layer.pipe(Layer.provide(ManagedPolicy.layer))),
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
      Layer.provide(PeerClientPairingHttp.layer.pipe(Layer.provide(PeerClientPairing.layerIssuer))),
      Layer.provide(CloudHttp.layer),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(layerPullRequestHttp),
      Layer.provide(layerProjectHttp),
      Layer.provide(ServerHttp.canvasHttpApiLayer),
      Layer.provide(speechHttpApiLayer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(WebhookRoute.layer.pipe(Layer.provide(RelayDeliveryProof.layer))),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    ServerHttp.layerOtlpTracesProxyRoute,
    ServerHttp.layerAssetRoute,
    pluginAssetRouteLayer,
    pluginHttpRouteLayer,
    ServerHttp.layerAttachmentUploadRoute,
    GuestHttp.layer,
    LinkThreadHttp.layer,
    ServerHttp.layerCanvasAvailability,
    layerDeviceHubProxy,
    layerBrowserStreamRoute,
    layerPreviewTunnelRoute,
    ServerHttp.layerStaticAndDevRoute,
    Ws.layer,
    speechStreamRouteLayer,
  ),
  McpHttpServer.layer.pipe(
    Layer.provide(layerProviderAdapterRegistry),
    Layer.provide(McpOAuth.layerMcpClientAuthenticator),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  // Follows delegated tasks running in linked environments, including after a restart.
  builtinLifecycleLayer(
    "t3.thread",
    "t3/server/root/remote-delegation",
    RemoteDelegation.RemoteDelegation.pipe(Effect.flatMap((remote) => remote.start())),
  ),
).pipe(
  // Guides read through the same pull request service as every other surface.
  Layer.provide(layerPullRequestReviewGuideService),
  // delegate_task to a linked environment, from /mcp and the follower above.
  Layer.provide(RemoteDelegation.layer.pipe(Layer.provide(ProjectionStoreV2.layer))),
  // Links agents ask for: shown in a thread from /mcp, answered over WebSocket.
  Layer.provide(PeerLinkRequests.layer),
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP. Provided
  // after the guide service so it reaches that too.
  Layer.provide(layerPullRequestService),
  Layer.provide(layerThreadIssueService),
  Layer.provide(layerIssueService),
  // The stream route and the WebSocket RPCs share one browser.
  Layer.provide(layerServerBrowser),
  // Server browser tabs and HTML render previews install and run the same headless browser.
  Layer.provide(layerPreviewBrowser),
  // Links to other environments, shared by clients (WebSocket) and agents (/mcp).
  Layer.provide(
    Layer.mergeAll(PeerForwarding.layer, PeerThreadRelay.layer, PeerClientPairing.layer).pipe(
      Layer.provideMerge(PeerMcpClient.layer),
      Layer.provideMerge(PeerLinks.layer),
    ),
  ),
  Layer.provide(
    SpeechService.layer.pipe(
      Layer.provide(layerServerSettings),
      Layer.provide(SpeechModelStore.layer),
    ),
  ),
  Layer.provide(CloudSpeech.layer.pipe(Layer.provide(SecretResolver.layer))),
  Layer.provide(layerServerSettings),
  Layer.provide(layerPreviewAutomationBroker),
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
    // The loader's preference read is bootstrap I/O, before application factories exist.
    const preferences = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFSP.readFile(
            NodePath.join(config.stateDir, "plugins-state.json"),
            "utf8",
          );
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
            return "{}";
          throw cause;
        }
      },
      catch: () => new PluginError({ message: "Could not read plugin preferences." }),
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
        ),
      ),
      Effect.orElseSucceed(() => ({})),
    );
    const kernelLayer = layerWithEnabled({
      ...preferences,
      "t3.persistence": true,
      "t3.auth": true,
      "t3.http": true,
      "t3.server": true,
    });
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = builtinSucceedLayer("t3.server")(
      ServerActivation.ServerActivation,
      awaitActivation,
    );
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const cloudLinkParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const layerLauncher = ServiceLauncherClient.layer;

    // fixPath rewrites PATH, so pin the launcher the shell chose before it does.
    const invokedAs = (yield* resolveLauncherPath) ?? (yield* HostProcess.InvokedAs);
    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });

    const layerHttpListening = builtinLifecycleLayer(
      "t3.server",
      "t3/server/root/lifecycle-7",
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const layerDesktopReadySignal = builtinLifecycleLayer(
      "t3.server",
      "t3/server/root/desktop-ready-signal",
      Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
        yield* startup.awaitCommandReady.pipe(
          Effect.andThen(receiver.announceServerReady),
          Effect.ignore,
          Effect.forkScoped,
        );
      }),
    );
    const layerRuntimeState = builtinLifecycleLayer(
      "t3.server",
      "t3/server/root/lifecycle-8",
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
    const tailscaleServeRootHolder = (target: { readonly host: string; readonly port: number }) =>
      readTailscaleServeRootHolder(config.tailscaleServePort, target);
    const layerTailscaleServe = config.tailscaleServeEnabled
      ? builtinLifecycleLayer(
          "t3.connections",
          "t3/server/root/lifecycle-9",
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
              const route = {
                localPort,
                urlHost: localHost,
                localHost: localHost.replace(/^\[|\]$/gu, ""),
                servePort: config.tailscaleServePort,
              };
              const holder = yield* tailscaleServeRootHolder({
                host: route.localHost,
                port: localPort,
              }).pipe(Effect.orElseSucceed(() => "unreadable" as const));
              if (holder === "other" || holder === "unreadable") {
                yield* Effect.logWarning(
                  holder === "other"
                    ? "Tailscale Serve left off; its port already serves another server or app"
                    : "Tailscale Serve left off; its current routes could not be read",
                  { localPort, servePort: config.tailscaleServePort },
                );
                return route;
              }
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost,
              }).pipe(
                Effect.as(route),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning(
                    cause._tag === "TailscaleCommandExitError" &&
                      cause.stderrDiagnostic === "unsupported-target"
                      ? `Tailscale Serve left off; this Tailscale install can only proxy to localhost, not ${localHost}. Bind --host 127.0.0.1 or 0.0.0.0 instead`
                      : "Failed to configure Tailscale Serve",
                    { cause, localPort, servePort: config.tailscaleServePort },
                  ).pipe(Effect.as(null)),
                ),
              );
            }),
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
                      tailscaleServeRootHolder({
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
        ).pipe(
          Layer.provide(NetService.layer),
          Layer.tap(() => Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie)),
        )
      : Layer.empty;
    const layerCloudDesiredLinkReconcile = builtinLifecycleLayer(
      "t3.connections",
      "t3/server/root/lifecycle-10",
      Effect.gen(function* () {
        const cloudLink = yield* CloudLink.CloudLink;
        // CloudLink unlinks on startup when the policy turns Connect off; nothing to restore.
        if (!ManagedLimits.allowsConnect(yield* ManagedPolicy.ManagedPolicy)) {
          yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
          return;
        }
        const releaseManagedTunnel = cloudLink.releaseManagedTunnelOnShutdown().pipe(
          Effect.timeout("10 seconds"),
          Effect.tap((released) =>
            released ? Effect.logInfo("Released the managed tunnel on shutdown") : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Failed to release the managed tunnel on shutdown; the next link reuses it",
              { errors: Cause.prettyErrors(cause).map((error) => error.message) },
            ),
          ),
          Effect.asVoid,
        );
        // Trials own cleanup immediately after the old server exits, retaining tunnels for commit/rollback unless explicitly stopped.
        // Other runtimes wait for activation so failed standbys cannot tear down active tunnels.
        const cleanupBeforeActivation = yield* pendingServiceUpdateExists;
        if (cleanupBeforeActivation) {
          yield* Effect.addFinalizer(() => releaseManagedTunnel);
        }
        yield* ServerActivation.forkParked(
          Effect.gen(function* () {
            if (!cleanupBeforeActivation) {
              yield* Effect.addFinalizer(() => releaseManagedTunnel);
            }
            const server = yield* HttpServer.HttpServer;
            const address = server.address;
            if (typeof address === "string" || !("port" in address)) return;
            const localOrigin = `http://${loopbackUrlHostForAddress(address)}:${address.port}`;
            const endpointRuntime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
            const runManagedTunnelRecovery = yield* makeManagedTunnelRecovery({
              recover: (config: RelayManagedEndpointRuntimeConfig) =>
                cloudLink.recoverManagedTunnel(localOrigin, config, {
                  retryRuntimeFailures: true,
                }),
              isRetryable: (error) =>
                CloudLink.shouldRetryCloudLink(error) &&
                error._tag !== "CloudLinkEndpointUnavailableError",
            });
            const recoverManagedTunnel = (config: RelayManagedEndpointRuntimeConfig) =>
              runManagedTunnelRecovery(config).pipe(
                Effect.tap((recovered) =>
                  recovered ? Effect.logInfo("T3 Connect managed tunnel recovered") : Effect.void,
                ),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("Failed to recover the T3 Connect managed tunnel", {
                        cause,
                      }),
                ),
              );
            yield* endpointRuntime.recoveryRequests.pipe(
              Stream.runForEach(recoverManagedTunnel),
              Effect.forkScoped,
            );
            yield* watchManagedTunnelOrigin({
              localOrigin,
              readIngressOrigin: endpointRuntime.inspectConnector.pipe(
                Effect.map((connector) => connector?.origin ?? null),
              ),
              // Like startup, a publish-only link never routes the tunnel to this host.
              register: CloudCliState.readCliDesiredLinkMode.pipe(
                Effect.flatMap((mode) =>
                  mode === "publish_only"
                    ? Effect.void
                    : cloudLink
                        .registerManagedTunnelRecovery(localOrigin)
                        .pipe(
                          Effect.flatMap((registration) =>
                            registration.status === "recovery_required"
                              ? endpointRuntime.requestRecovery(registration.config)
                              : Effect.void,
                          ),
                        ),
                ),
              ),
            }).pipe(Effect.forkScoped);
            const wantsCliLink = hasCloudPublicConfig
              ? yield* CloudCliState.readCliDesiredCloudLink.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link", { cause }).pipe(
                      Effect.as(false),
                    ),
                  ),
                )
              : false;
            // Recover reads so this fiber still registers and consumes recovery requests.
            const desiredCliLinkMode = wantsCliLink
              ? yield* CloudCliState.readCliDesiredLinkMode.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link mode", {
                      cause,
                    }).pipe(Effect.as("managed" as const)),
                  ),
                )
              : null;
            // Publish-only links must not expose the host through old managed configs.
            const startedConfirmed =
              desiredCliLinkMode === "publish_only"
                ? false
                : yield* cloudLink.startManagedTunnelIfOriginConfirmed(localOrigin).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to start the confirmed T3 Connect tunnel", {
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  );
            const startStoredManagedTunnel = cloudLink
              .startManagedTunnelIfOriginConfirmed(localOrigin, {
                requireConfirmedOrigin: false,
              })
              .pipe(
                Effect.tap((started) =>
                  started
                    ? Effect.logWarning(
                        "T3 Connect started the stored tunnel without relay confirmation",
                      )
                    : Effect.void,
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to start the stored T3 Connect tunnel", { cause }),
                ),
                Effect.asVoid,
              );
            const registerManagedTunnel = retryManagedTunnelRegistration(
              cloudLink.registerManagedTunnelRecovery(localOrigin, {
                retryRuntimeFailures: true,
              }),
              (error) =>
                CloudLink.shouldRetryCloudLink(error) &&
                error._tag !== "CloudLinkEndpointUnavailableError",
              startedConfirmed ? Effect.void : startStoredManagedTunnel,
            ).pipe(
              Effect.tap((result) =>
                result.status === "ready"
                  ? Effect.logInfo("T3 Connect managed tunnel recovery registered")
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to register T3 Connect managed tunnel recovery", {
                      cause,
                    }).pipe(Effect.as({ status: "unavailable" as const })),
              ),
            );
            // Jitter registrations so update waves do not hit the relay simultaneously.
            if (!startedConfirmed && desiredCliLinkMode !== "publish_only") {
              const jitter = yield* Random.nextIntBetween(
                0,
                Duration.toMillis(MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER),
              );
              yield* Effect.sleep(Duration.millis(jitter));
            }
            const registration =
              desiredCliLinkMode === "publish_only"
                ? { status: "not_linked" as const }
                : yield* registerManagedTunnel;
            if (registration.status === "unavailable" && !startedConfirmed) {
              yield* startStoredManagedTunnel;
            }
            const startupAction = managedTunnelStartupAction({ wantsCliLink, registration });
            if (startupAction.action === "request_recovery") {
              yield* endpointRuntime.requestRecovery(startupAction.config);
            }
            if (startupAction.action === "reconcile_link") {
              const reconciledMode = yield* cloudLink
                .reconcileDesiredLinkIfStillDesired(localOrigin)
                .pipe(
                  (reconcile) =>
                    retryDesiredLinkReconcile(reconcile, CloudLink.shouldRetryCloudLink, (cause) =>
                      Effect.logWarning(
                        "T3 Connect relay is still unavailable; retrying the desired link in the background",
                        { cause },
                      ),
                    ),
                  Effect.tap((mode) =>
                    mode === null
                      ? Effect.void
                      : Effect.logInfo("T3 Connect desired link reconciled on startup"),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to reconcile T3 Connect desired link on startup", {
                      cause,
                    }).pipe(Effect.as(null)),
                  ),
                );
              if (reconciledMode === "managed") {
                const afterReconcile = yield* registerManagedTunnel;
                if (afterReconcile.status === "recovery_required") {
                  yield* endpointRuntime.requestRecovery(afterReconcile.config);
                }
              }
            }
          }),
        );
        yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
      }),
    ).pipe(Layer.tap(() => Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie)));

    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(cloudLinkParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(layerRuntimeDependencies), Layer.provide(layerLauncher));

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
      layerCloudDesiredLinkReconcile,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      Layer.provide(CloudLink.layer.pipe(Layer.provideMerge(ConnectReachability.layer))),
      Layer.provideMerge(layerRuntimeServices),
      Layer.provideMerge(
        McpSessionRegistry.layer.pipe(
          Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        ),
      ),
      Layer.provide(layerActivation),
      Layer.provideMerge(
        RelayTracing.layerServerRelayBroker.pipe(Layer.provide(ManagedPolicy.layer)),
      ),
      Layer.provideMerge(layerHttpServer),
      Layer.provide(layerApplicationObservability),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(layerPlatformServices),
      Layer.provide(Layer.succeed(HostProcess.InvokedAs, invokedAs)),
      Layer.provideMerge(kernelLayer),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer));

export const runServer = Layer.launch(
  // For the layers above whose spawner requirement is not met by one of them.
  layerMakeServer.pipe(Layer.provide(NonBlockingSpawner.layer.pipe(Layer.provide(layerSpawner)))),
);
