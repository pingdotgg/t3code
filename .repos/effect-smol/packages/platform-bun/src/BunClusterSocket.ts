/**
 * The `BunClusterSocket` module provides the Bun socket transport for Effect
 * Cluster runners. It wires `SocketRunner` to Bun-compatible TCP sockets,
 * supplies RPC client and server protocol layers, and builds a complete
 * sharding layer with serialization, runner health, runner storage, and message
 * storage.
 *
 * **Common tasks**
 *
 * - Run a Bun process as a cluster runner over raw TCP sockets with
 *   {@link layer}
 * - Connect a client-only process to an existing socket cluster without
 *   starting a runner server
 * - Use SQL-backed storage for durable multi-process clusters, `local` storage
 *   for short-lived development, or `byo` storage when the deployment owns the
 *   persistence boundary
 * - Check runner health with socket pings or Kubernetes pod readiness through
 *   {@link layerK8sHttpClient}
 *
 * **Gotchas**
 *
 * - `runnerAddress` is the host and port advertised to other runners; set
 *   `runnerListenAddress` when the local bind address differs from the
 *   externally reachable address
 * - The socket transport is point-to-point RPC, not cluster gossip: runner
 *   membership, shard ownership, and persisted delivery are coordinated through
 *   `RunnerStorage`, `MessageStorage`, and `RunnerHealth`
 * - `clientOnly` does not start a socket server or receive shard assignments
 * - SQL storage is the default; `local` storage is in-memory/noop and `byo`
 *   requires the surrounding application to provide both runner and message
 *   storage services
 * - Ping health checks use the same socket protocol, so unreachable ports,
 *   firewalls, or serialization mismatches can make a runner appear unhealthy
 * - Kubernetes health checks use Bun's Fetch-backed HTTP client and the service
 *   account CA certificate when it is available
 *
 * @since 4.0.0
 */
import { layerClientProtocol, layerSocketServer } from "@effect/platform-node-shared/NodeClusterSocket"
import type * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as K8sHttpClient from "effect/unstable/cluster/K8sHttpClient"
import * as MessageStorage from "effect/unstable/cluster/MessageStorage"
import * as RunnerHealth from "effect/unstable/cluster/RunnerHealth"
import * as Runners from "effect/unstable/cluster/Runners"
import * as RunnerStorage from "effect/unstable/cluster/RunnerStorage"
import type { Sharding } from "effect/unstable/cluster/Sharding"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as SocketRunner from "effect/unstable/cluster/SocketRunner"
import * as SqlMessageStorage from "effect/unstable/cluster/SqlMessageStorage"
import * as SqlRunnerStorage from "effect/unstable/cluster/SqlRunnerStorage"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type * as SocketServer from "effect/unstable/socket/SocketServer"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import * as BunFileSystem from "./BunFileSystem.ts"

export {
  /**
   * Provides the cluster `RpcClientProtocol` using the shared socket client
   * implementation.
   *
   * @category re-exports
   * @since 4.0.0
   */
  layerClientProtocol,
  /**
   * Provides the socket server used by Bun cluster runners through the shared
   * socket server implementation.
   *
   * @category re-exports
   * @since 4.0.0
   */
  layerSocketServer
}

/**
 * Creates Bun socket cluster layers, configuring serialization, storage, runner health, and optional client-only mode.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <
  const ClientOnly extends boolean = false,
  const Storage extends "local" | "sql" | "byo" = never
>(
  options?: {
    readonly serialization?: "msgpack" | "ndjson" | undefined
    readonly clientOnly?: ClientOnly | undefined
    readonly storage?: Storage | undefined
    readonly runnerHealth?: "ping" | "k8s" | undefined
    readonly runnerHealthK8s?: {
      readonly namespace?: string | undefined
      readonly labelSelector?: string | undefined
    } | undefined
    readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined
  }
): ClientOnly extends true ? Layer.Layer<
    Sharding | Runners.Runners | ("byo" extends Storage ? never : MessageStorage.MessageStorage),
    Config.ConfigError,
    "local" extends Storage ? never
      : "byo" extends Storage ? (MessageStorage.MessageStorage | RunnerStorage.RunnerStorage)
      : SqlClient
  > :
  Layer.Layer<
    Sharding | Runners.Runners | ("byo" extends Storage ? never : MessageStorage.MessageStorage),
    SocketServer.SocketServerError | Config.ConfigError,
    "local" extends Storage ? never
      : "byo" extends Storage ? (MessageStorage.MessageStorage | RunnerStorage.RunnerStorage)
      : SqlClient
  > =>
{
  const layer: Layer.Layer<any, any, any> = options?.clientOnly
    // client only
    ? Layer.provide(SocketRunner.layerClientOnly, layerClientProtocol)
    // with server
    : Layer.provide(SocketRunner.layer, [layerSocketServer, layerClientProtocol])

  const runnerHealth: Layer.Layer<any, any, any> = options?.clientOnly
    ? Layer.empty as any
    : options?.runnerHealth === "k8s"
    ? RunnerHealth.layerK8s(options.runnerHealthK8s).pipe(
      Layer.provide([BunFileSystem.layer, layerK8sHttpClient])
    )
    : RunnerHealth.layerPing.pipe(
      Layer.provide(Runners.layerRpc),
      Layer.provide(layerClientProtocol)
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
 * Layer that provides `K8sHttpClient`, using the Kubernetes service-account CA certificate when it is available.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerK8sHttpClient: Layer.Layer<K8sHttpClient.K8sHttpClient> = K8sHttpClient.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const caCertOption = yield* fs.readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt").pipe(
      Effect.option
    )
    if (caCertOption._tag === "None") {
      return FetchHttpClient.layer
    }

    return Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, {
        tls: {
          ca: caCertOption.value
        }
      } as any))
    )
  }))),
  Layer.provide(BunFileSystem.layer)
)
