import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import http from "node:http";

import { ServerConfig } from "./config";
import { Open, OpenLive } from "./open";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { ServerRuntimeStateLive } from "./serverRuntime";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { makeRoutesLayer } from "./wsServer";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => ({
      threadCount: snapshot.threads.length,
      projectCount: snapshot.projects.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup snapshot for telemetry", { cause }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

const logServerReady = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const open = yield* Open;
  const server = yield* HttpServer.HttpServer;

  if (server.address._tag !== "TcpAddress") {
    return;
  }

  const { port } = server.address;
  const localUrl = `http://localhost:${port}`;
  const bindUrl =
    config.host && !isWildcardHost(config.host)
      ? `http://${formatHostForUrl(config.host)}:${port}`
      : localUrl;

  yield* Effect.logInfo("T3 Code running", {
    url: bindUrl,
    localUrl,
    bindHost: config.host ?? "default",
    cwd: config.cwd,
    mode: config.mode,
    stateDir: config.stateDir,
    authEnabled: Boolean(config.authToken),
    websocketUrl: `${bindUrl}/ws`,
  });

  if (config.noBrowser) {
    return;
  }

  const target = config.devUrl?.toString() ?? bindUrl;
  yield* open.openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        hint: `Open ${target} in your browser.`,
      }),
    ),
  );
});

const startupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* logServerReady;
    yield* Effect.forkChild(recordStartupHeartbeat);
  }),
);

export const makeNodeHttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig;
    return NodeHttpServer.layer(http.createServer, host ? { host, port } : { port });
  }),
);

const routesLayer = HttpRouter.serve(makeRoutesLayer, {
  disableLogger: true,
  disableListenLog: true,
});

export const makeServerServicesLayer = () => {
  const nodeServicesLayer = NodeServices.layer;
  const fetchHttpClientLayer = FetchHttpClient.layer.pipe(Layer.provideMerge(nodeServicesLayer));
  const sqliteLayer = SqlitePersistence.layerConfig.pipe(Layer.provideMerge(nodeServicesLayer));
  const analyticsLayer = AnalyticsServiceLayerLive.pipe(
    Layer.provideMerge(fetchHttpClientLayer),
    Layer.provideMerge(nodeServicesLayer),
  );
  const providerLayer = makeServerProviderLayer().pipe(
    Layer.provideMerge(analyticsLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(nodeServicesLayer),
  );
  const runtimeLayer = makeServerRuntimeServicesLayer().pipe(
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(nodeServicesLayer),
  );
  const providerHealthLayer = ProviderHealthLive.pipe(Layer.provideMerge(nodeServicesLayer));
  const openLayer = OpenLive.pipe(Layer.provideMerge(nodeServicesLayer));
  const baseServicesLayer = Layer.mergeAll(
    nodeServicesLayer,
    fetchHttpClientLayer,
    analyticsLayer,
    runtimeLayer,
    providerLayer,
    providerHealthLayer,
    openLayer,
    sqliteLayer,
  );

  return Layer.mergeAll(
    baseServicesLayer,
    ServerRuntimeStateLive.pipe(Layer.provide(baseServicesLayer)),
  );
};

export const makeServerAppLayer = <ServicesSuccess, ServicesError, ServicesRequirements>(
  servicesLayer: Layer.Layer<ServicesSuccess, ServicesError, ServicesRequirements>,
) =>
  routesLayer.pipe(Layer.provideMerge(startupLayer)).pipe(Layer.provide(servicesLayer));

export const makeServerLayer = makeServerAppLayer(makeServerServicesLayer()).pipe(
  Layer.provide(makeNodeHttpServerLayer),
);

export const runServer = Layer.launch(makeServerLayer);
