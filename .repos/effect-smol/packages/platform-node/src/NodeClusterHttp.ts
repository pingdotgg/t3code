/**
 * The `NodeClusterHttp` module provides the Node.js HTTP and WebSocket
 * transports for Effect Cluster runners. It wires `HttpRunner` to the Node HTTP
 * server, supplies Undici and WebSocket client protocols, and builds a complete
 * sharding layer with serialization, runner health, runner storage, and message
 * storage.
 *
 * **Common tasks**
 *
 * - Run a Node process as a cluster runner over HTTP or WebSocket with
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
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform"
import type { HttpServer } from "effect/unstable/http/HttpServer"
import type { ServeError } from "effect/unstable/http/HttpServerError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { createServer } from "node:http"
import { layerK8sHttpClient } from "./NodeClusterSocket.ts"
import * as NodeHttpClient from "./NodeHttpClient.ts"
import * as NodeHttpServer from "./NodeHttpServer.ts"
import type { NodeServices } from "./NodeServices.ts"
import * as NodeSocket from "./NodeSocket.ts"

export {
  /**
   * Provides the Kubernetes HTTP client layer used by Kubernetes runner health checks.
   *
   * @category re-exports
   * @since 4.0.0
   */
  layerK8sHttpClient
} from "./NodeClusterSocket.ts"

/**
 * Builds the Node cluster HTTP/WebSocket sharding layer, configuring runner
 * transport, RPC serialization, message storage, runner health checks, and
 * optional client-only mode.
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
    Sharding | Runners.Runners | ("byo" extends Storage ? never : MessageStorage.MessageStorage),
    ServeError | Config.ConfigError,
    "local" extends Storage ? never
      : "byo" extends Storage ? (MessageStorage.MessageStorage | RunnerStorage.RunnerStorage)
      : SqlClient
  > =>
{
  const layer: Layer.Layer<any, any, any> = options.clientOnly
    // client only
    ? options.transport === "http"
      ? Layer.provide(HttpRunner.layerHttpClientOnly, NodeHttpClient.layerUndici)
      : Layer.provide(HttpRunner.layerWebsocketClientOnly, NodeSocket.layerWebSocketConstructor)
    // with server
    : options.transport === "http"
    ? Layer.provide(HttpRunner.layerHttp, [layerHttpServer, NodeHttpClient.layerUndici])
    : Layer.provide(HttpRunner.layerWebsocket, [layerHttpServer, NodeSocket.layerWebSocketConstructor])

  const runnerHealth: Layer.Layer<any, any, any> = options?.clientOnly
    ? Layer.empty as any
    : options?.runnerHealth === "k8s"
    ? RunnerHealth.layerK8s(options.runnerHealthK8s).pipe(
      Layer.provide(layerK8sHttpClient)
    )
    : RunnerHealth.layerPing.pipe(
      Layer.provide(Runners.layerRpc),
      Layer.provide(
        options.transport === "http"
          ? HttpRunner.layerClientProtocolHttpDefault.pipe(Layer.provide(NodeHttpClient.layerUndici))
          : HttpRunner.layerClientProtocolWebsocketDefault.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor))
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

/**
 * Provides the HTTP server and Node HTTP services used by cluster runners,
 * listening on `ShardingConfig.runnerListenAddress` or `runnerAddress`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerHttpServer: Layer.Layer<
  | HttpPlatform
  | Etag.Generator
  | NodeServices
  | HttpServer,
  ServeError,
  ShardingConfig.ShardingConfig
> = Effect.gen(function*() {
  const config = yield* ShardingConfig.ShardingConfig
  const listenAddress = Option.orElse(config.runnerListenAddress, () => config.runnerAddress)
  if (Option.isNone(listenAddress)) {
    return yield* Effect.die("NodeClusterHttp.layerHttpServer: ShardingConfig.runnerAddress is None")
  }
  return NodeHttpServer.layer(createServer, listenAddress.value)
}).pipe(Layer.unwrap)
