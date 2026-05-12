import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import {
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
} from "./http.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import { ProviderEventLoggersLive } from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { OpenCodeRuntimeLive } from "./provider/opencodeRuntime.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import * as GitManager from "./git/GitManager.ts";
import { KeybindingsLive } from "./keybindings.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment.ts";
import {
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
} from "./auth/http.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
} from "./orchestration/http.ts";
import * as NetService from "@t3tools/shared/Net";
import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";

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
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
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

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggersLive` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const SourceControlProviderRegistryLayerLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(AzureDevOpsCli.layer, BitbucketApi.layer, GitHubCli.layer, GitLabCli.layer),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(ProjectSetupScriptRunnerLive),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(TextGeneration.layer),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitVcsDriver.layer),
);

const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

const SourceControlRepositoryServiceLayerLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
);

const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
  Layer.provideMerge(GitWorkflowLayerLive),
  Layer.provideMerge(SourceControlRepositoryServiceLayerLive),
  Layer.provideMerge(VcsStatusBroadcaster.layer.pipe(Layer.provide(GitWorkflowLayerLive))),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const WorkspaceEntriesLayerLive = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
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
  Layer.provide(ServerSecretStoreLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(VcsLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
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
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  Layer.provideMerge(ProviderEventLoggersLive),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntimeLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(AuthLayerLive),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(ProcessDiagnostics.layer),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provide(NetService.layer),
);

const RuntimeServicesLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
);

export const makeRoutesLayer = Layer.mergeAll(
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSessionRouteLayer,
  authWebSocketTokenRouteLayer,
  attachmentsRouteLayer,
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
).pipe(Layer.provide(browserApiCorsLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

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

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          });
        }),
        () => clearPersistedServerRuntimeState(config.serverRuntimeStatePath),
      ),
    );
    const tailscaleServeLayer = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
      runtimeStateLayer,
      tailscaleServeLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer);
