import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  type AuthAccessStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "./auth/RpcAuthorization.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as Keybindings from "./keybindings.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.subscribeAuthAccess> =>
      tag !== WS_METHODS.subscribeAuthAccess,
  ),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedAuthAccessRpcServices = Layer.mergeAll(
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(DirectEndpoints.DirectEndpoints)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(ExternalLauncher.ExternalLauncher)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(Keybindings.Keybindings)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PortScanner.PortDiscovery)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(ServerSettings.ServerSettingsService)({}),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(UsageLimitSources.UsageLimitSources)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-access-stream-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "keeps an access change made before the snapshot ACK, then releases both subscriptions",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const current = yield* sessions.issue({ subject: "current-client" });
      const subscribed = yield* Queue.unbounded<void>();
      const released = yield* Queue.unbounded<void>();
      // Report each live subscription on either accessor so the test fails, rather
      // than hangs, against a handler that subscribes after the snapshot.
      const tracked = <A>(changes: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>) =>
        changes.pipe(
          Effect.tap(() => Queue.offer(subscribed, undefined)),
          Effect.tap(() => Effect.addFinalizer(() => Queue.offer(released, undefined))),
        );
      const pairingLinkChanges = tracked(pairingLinks.subscribeChanges);
      const clientChanges = tracked(sessions.subscribeChanges);
      const responses = yield* Queue.unbounded<AuthAccessStreamEvent>();
      const exited = yield* Deferred.make<void>();
      const server = yield* RpcServer.makeNoSerialization(group, {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                discard: true,
              })
            : response._tag === "Exit"
              ? Deferred.succeed(exited, undefined)
              : Effect.void,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerWsRpc(
              {
                sessionId: current.sessionId,
                subject: "current-client",
                method: "browser-session-cookie",
                scopes: AuthAdministrativeScopes,
              },
              {},
              {},
              yield* PreviewAutomationBroker.PreviewAutomationBroker,
              yield* ServerBrowser.ServerBrowser,
            ).pipe(
              Layer.provide(
                Layer.mergeAll(
                  layerUnusedAuthAccessRpcServices,
                  Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth),
                  Layer.succeed(PairingGrantStore.PairingGrantStore, {
                    ...pairingLinks,
                    streamChanges: Stream.unwrap(pairingLinkChanges),
                    subscribeChanges: pairingLinkChanges,
                  }),
                  Layer.succeed(SessionStore.SessionStore, {
                    ...sessions,
                    streamChanges: Stream.unwrap(clientChanges),
                    subscribeChanges: clientChanges,
                  }),
                ),
              ),
            ),
            RpcAuthorization.layer(AuthAdministrativeScopes),
          ),
        ),
      );
      const requestId = RpcMessage.RequestId("auth-access");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeAuthAccess,
        payload: {},
        headers: Headers.empty,
      });

      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.isFalse(snapshot.payload.clientSessions[0]?.connected);
      yield* sessions.markConnected(current.sessionId);
      yield* acknowledge;
      yield* Queue.take(subscribed);
      yield* Queue.take(subscribed);

      // A later change reaches either implementation, so a handler that dropped
      // the first change fails here instead of waiting for a timeout.
      yield* sessions.markDisconnected(current.sessionId);
      const missed = yield* Queue.take(responses);
      assert.equal(missed.revision, 2);
      assert.equal(missed.type, "clientUpserted");
      if (missed.type === "clientUpserted") assert.isTrue(missed.payload.connected);
      yield* acknowledge;
      const latest = yield* Queue.take(responses);
      assert.equal(latest.revision, 3);
      assert.equal(latest.type, "clientUpserted");
      if (latest.type === "clientUpserted") assert.isFalse(latest.payload.connected);

      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
      yield* Deferred.await(exited);
      yield* Queue.take(released);
      yield* Queue.take(released);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerAuth),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);
