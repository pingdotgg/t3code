import * as Net from "node:net";
import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Effect, Layer, Path } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig, ServerConfigShape } from "./config";
import { attachmentsRouteLayer, healthRouteLayer, staticAndDevRouteLayer } from "./http";
import { fixPath } from "./os-jank";
import { websocketRpcRouteLayer } from "./ws";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { OpenLive } from "./open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitServiceLive } from "./git/Layers/GitService";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { CodexTextGenerationLive } from "./git/Layers/CodexTextGeneration";
import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { BunPtyAdapterLive } from "./terminal/Layers/BunPTY";
import { NodePtyAdapterLive } from "./terminal/Layers/NodePTY";
import { GitManagerLive } from "./git/Layers/GitManager";
import { KeybindingsLive } from "./keybindings";
import { ServerLoggerLive } from "./serverLogger";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const OrchestrationLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(OrchestrationEngineLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const path = yield* Path.Path;
    const providerLogsDir = path.join(stateDir, "logs", "provider");
    const providerEventLogPath = path.join(providerLogsDir, "events.log");
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
  }),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitServiceLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(CodexTextGenerationLive),
);

const TerminalLayerLive = TerminalManagerLive.pipe(
  Layer.provide(
    typeof Bun !== "undefined" && process.platform !== "win32"
      ? BunPtyAdapterLive
      : NodePtyAdapterLive,
  ),
);

const runtimeServicesLayer = Layer.empty.pipe(
  Layer.provideMerge(ServerRuntimeStartupLive),
  Layer.provideMerge(ReactorLayerLive),

  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),

  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ProviderHealthLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
);

const HttpServerLive =
  typeof Bun !== "undefined"
    ? (listenOptions: ServerConfigShape) =>
        BunHttpServer.layer({
          port: listenOptions.port,
          ...(listenOptions.host ? { hostname: listenOptions.host } : {}),
        })
    : (listenOptions: ServerConfigShape) =>
        NodeHttpServer.layer(Http.createServer, {
          host: listenOptions.host,
          port: listenOptions.port,
        });
const ServicesLive = typeof Bun !== "undefined" ? BunServices.layer : NodeServices.layer;

export const makeRoutesLayer = Layer.mergeAll(
  healthRouteLayer,
  attachmentsRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
);

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

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(HttpServerLive(config)),
      Layer.provide(ServerLoggerLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(ServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
