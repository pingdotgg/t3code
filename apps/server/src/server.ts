import { Effect, Layer } from "effect";
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
import { OpenLive } from "./open.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService.ts";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime.ts";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter.ts";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter.ts";
import { makeCursorAdapterLive } from "./provider/Layers/CursorAdapter.ts";
import { makeOpenCodeAdapterLive } from "./provider/Layers/OpenCodeAdapter.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitHubCliLive } from "./git/Layers/GitHubCli.ts";
import { GitStatusBroadcasterLive } from "./git/Layers/GitStatusBroadcaster.ts";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import { GitManagerLive } from "./git/Layers/GitManager.ts";
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

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const openCodeAdapterLayer = makeOpenCodeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const cursorAdapterLayer = makeCursorAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provide(openCodeAdapterLayer),
      Layer.provide(cursorAdapterLayer),
      Layer.provideMerge(ProviderSessionDirectoryLayerLive),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provideMerge(ProviderSessionDirectoryLayerLive),
    );
  }),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const GitManagerLayerLive = GitManagerLive.pipe(
  Layer.provideMerge(ProjectSetupScriptRunnerLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(RoutingTextGenerationLive),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitStatusBroadcasterLive.pipe(Layer.provide(GitManagerLayerLive))),
  Layer.provideMerge(GitCoreLive),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

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
  Layer.provide(ServerSecretStoreLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const RuntimeDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(AuthLayerLive),

  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
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

          const state = makePersistedServerRuntimeState({
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

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
      runtimeStateLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
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
