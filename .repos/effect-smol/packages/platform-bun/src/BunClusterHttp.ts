/**
 * The `BunClusterHttp` module provides the Bun HTTP and WebSocket transports
 * for Effect Cluster runners. It wires `HttpRunner` to the Bun HTTP server,
 * supplies Fetch and Bun WebSocket client protocols, and builds a complete
 * sharding layer with serialization, runner health, runner storage, and message
 * storage.
 *
 * **Common tasks**
 *
 * - Run a Bun process as a cluster runner over HTTP or WebSocket with
 *   {@link layer}
 * - Connect a client-only process to an existing HTTP cluster without starting
 *   a runner server
 * - Use SQL-backed storage for durable multi-process clusters, `local` storage
 *   for short-lived development, or `byo` storage when the deployment owns the
 *   persistence boundary
 * - Check runner health with protocol pings or Kubernetes pod readiness through
 *   {@link layerK8sHttpClient}
 *
 * **Gotchas**
 *
 * - `runnerAddress` is the host and port advertised to other runners; set
 *   `runnerListenAddress` when the local bind address differs from the
 *   externally reachable address
 * - The HTTP and WebSocket transports serve runner RPCs at the default
 *   `HttpRunner` route, so proxies and load balancers must preserve the path
 *   and allow WebSocket upgrades when `transport` is `"websocket"`
 * - `clientOnly` does not start an HTTP server or receive shard assignments
 * - SQL storage is the default; `local` storage is in-memory/noop and `byo`
 *   requires the surrounding application to provide both runner and message
 *   storage services
 * - Ping health checks use the selected transport and serialization, so route,
 *   port, proxy, or codec mismatches can make a runner appear unhealthy
 *
 * @since 4.0.0
 */
import type * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpRunner from "effect/unstable/cluster/HttpRunner"
import * as MessageStorage from "effect/unstable/cluster/MessageStorage"
import * as RunnerHealth from "effect/unstable/cluster/RunnerHealth"
import * as Runners from "effect/unstable/cluster/Runners"
import * as RunnerStorage from "effect/unstable/cluster/RunnerStorage"
import type { Sharding } from "effect/unstable/cluster/Sharding"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as SqlMessageStorage from "effect/unstable/cluster/SqlMessageStorage"
import * as SqlRunnerStorage from "effect/unstable/cluster/SqlRunnerStorage"
import type * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform"
import type { HttpServer } from "effect/unstable/http/HttpServer"
import type { ServeError } from "effect/unstable/http/HttpServerError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { layerK8sHttpClient } from "./BunClusterSocket.ts"
import * as BunFileSystem from "./BunFileSystem.ts"
import * as BunHttpServer from "./BunHttpServer.ts"
import type { BunServices } from "./BunServices.ts"
import * as BunSocket from "./BunSocket.ts"

export {
  /**
   * Layer that provides a Kubernetes HTTP client for runner health checks.
   *
   * @category re-exports
   * @since 4.0.0
   */
  layerK8sHttpClient
}

/**
 * Layer that provides a Bun HTTP server for cluster runners.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerHttpServer: Layer.Layer<
  | HttpPlatform
  | Etag.Generator
  | BunServices
  | HttpServer,
  ServeError,
  ShardingConfig.ShardingConfig
> = Effect.gen(function*() {
  const config = yield* ShardingConfig.ShardingConfig
  const listenAddress = Option.orElse(config.runnerListenAddress, () => config.runnerAddress)
  if (Option.isNone(listenAddress)) {
    return yield* Effect.die("BunClusterHttp.layerHttpServer: ShardingConfig.runnerAddress is None")
  }
  return BunHttpServer.layer(listenAddress.value)
}).pipe(Layer.unwrap)

/**
 * Creates Bun cluster layers for HTTP or WebSocket transport, configuring serialization, storage, runner health, and optional client-only mode.
 *
 * **When to use**
 *
 * Use to install the complete Bun HTTP or WebSocket cluster layer, including
 * client-only cluster access when a process should connect without serving
 * runner RPCs.
 *
 * **Details**
 *
 * `serialization` defaults to MessagePack, `runnerHealth` defaults to ping
 * checks, SQL-backed storage is used by default, and `shardingConfig` is
 * overlaid on environment-loaded sharding configuration. `local` storage uses
 * no-op message storage plus in-memory runner storage, while `byo` leaves both
 * message and runner storage for the caller to provide.
 *
 * **Gotchas**
 *
 * `clientOnly` does not start the HTTP server or receive shard assignments.
 * Non-client-only mode listens with `runnerListenAddress` when present, falling
 * back to `runnerAddress`. HTTP and WebSocket runner RPCs use the default
 * `HttpRunner` route.
 *
 * @see {@link layerHttpServer} for the server layer used by non-client-only transports
 * @see {@link layerK8sHttpClient} for Kubernetes runner health support
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <
  const ClientOnly extends boolean = false,
  const Storage extends "local" | "sql" | "byo" = never
>(options: {
  readonly transport: "http" | "websocket"
  readonly serialization?: "msgpack" | "ndjson" | undefined
  readonly clientOnly?: ClientOnly | undefined
  readonly storage?: Storage | undefined
  readonly runnerHealth?: "ping" | "k8s" | undefined
  readonly runnerHealthK8s?: {
    readonly namespace?: string | undefined
    readonly labelSelector?: string | undefined
  } | undefined
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined
}): ClientOnly extends true ? Layer.Layer<
    Sharding | Runners.Runners | ("byo" extends Storage ? never : MessageStorage.MessageStorage),
    Config.ConfigError,
    "local" extends Storage ? never
      : "byo" extends Storage ? (MessageStorage.MessageStorage | RunnerStorage.RunnerStorage)
      : SqlClient
  > :
  Layer.Layer<
    Sharding | Runners.Runners | MessageStorage.MessageStorage,
    ServeError | Config.ConfigError,
    "local" extends Storage ? never
      : "byo" extends Storage ? (MessageStorage.MessageStorage | RunnerStorage.RunnerStorage)
      : SqlClient
  > =>
{
  const layer: Layer.Layer<any, any, any> = options.clientOnly
    // client only
    ? options.transport === "http"
      ? Layer.provide(HttpRunner.layerHttpClientOnly, FetchHttpClient.layer)
      : Layer.provide(HttpRunner.layerWebsocketClientOnly, BunSocket.layerWebSocketConstructor)
    // with server
    : options.transport === "http"
    ? Layer.provide(HttpRunner.layerHttp, [layerHttpServer, FetchHttpClient.layer])
    : Layer.provide(HttpRunner.layerWebsocket, [layerHttpServer, BunSocket.layerWebSocketConstructor])

  const runnerHealth: Layer.Layer<any, any, any> = options?.clientOnly
    ? Layer.empty as any
    : options?.runnerHealth === "k8s"
    ? RunnerHealth.layerK8s(options.runnerHealthK8s).pipe(
      Layer.provide([BunFileSystem.layer, layerK8sHttpClient])
    )
    : RunnerHealth.layerPing.pipe(
      Layer.provide(Runners.layerRpc),
      Layer.provide(
        options.transport === "http"
          ? HttpRunner.layerClientProtocolHttpDefault.pipe(Layer.provide(FetchHttpClient.layer))
          : HttpRunner.layerClientProtocolWebsocketDefault.pipe(Layer.provide(BunSocket.layerWebSocketConstructor))
      )
    )

  return layer.pipe(
    Layer.provide(runnerHealth),
    Layer.provideMerge(
      options?.storage === "local"
        ? MessageStorage.layerNoop
        : options?.storage === "byo"
        ? Layer.empty
        : Layer.orDie(SqlMessageStorage.layer)
    ),
    Layer.provide(
      options?.storage === "local"
        ? RunnerStorage.layerMemory
        : options?.storage === "byo"
        ? Layer.empty
        : Layer.orDie(SqlRunnerStorage.layer)
    ),
    Layer.provide(ShardingConfig.layerFromEnv(options?.shardingConfig)),
    Layer.provide(
      options?.serialization === "ndjson" ? RpcSerialization.layerNdjson : RpcSerialization.layerMsgPack
    )
  ) as any
}
