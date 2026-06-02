/**
 * The `SocketRunner` module wires cluster runner RPCs to socket transports. It
 * provides a complete runner layer that serves RPC handlers on a `SocketServer`
 * and installs `Sharding` and `Runners` clients for talking to other runners
 * through the socket RPC protocol.
 *
 * **Common tasks**
 *
 * - Run a cluster worker over TCP or Unix sockets with {@link layer}
 * - Connect to other runners while exposing `Sharding` and `Runners` clients
 * - Embed a client-only cluster participant with {@link layerClientOnly} when
 *   the process should send messages but not receive shard assignments
 *
 * **Transport gotchas**
 *
 * - The server listen address comes from the provided `SocketServer` and is
 *   logged when {@link layer} starts
 * - TCP addresses are logged as `hostname:port`, while Unix socket addresses
 *   are logged as their filesystem path
 * - The client-only layer does not start a socket server; provide the full
 *   layer when the process must accept runner RPCs
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type * as RpcSerialization from "../rpc/RpcSerialization.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import { SocketServer } from "../socket/SocketServer.ts"
import type { MessageStorage } from "./MessageStorage.ts"
import type { RunnerHealth } from "./RunnerHealth.ts"
import type * as Runners from "./Runners.ts"
import * as RunnerServer from "./RunnerServer.ts"
import type * as RunnerStorage from "./RunnerStorage.ts"
import type * as Sharding from "./Sharding.ts"
import type { ShardingConfig } from "./ShardingConfig.ts"

const withLogAddress = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R | SocketServer> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const server = yield* SocketServer
    const address = server.address._tag === "UnixAddress"
      ? server.address.path
      : `${server.address.hostname}:${server.address.port}`
    yield* Effect.annotateLogs(Effect.logInfo(`Listening on: ${address}`), {
      package: "@effect/cluster",
      service: "Runner"
    })
  })).pipe(Layer.provideMerge(layer))

/**
 * Layer that runs a cluster runner over the socket RPC protocol, providing
 * `Sharding` and `Runners` clients and logging the socket listen address.
 *
 * **When to use**
 *
 * Use when a cluster runner process should accept runner RPCs through a
 * provided `SocketServer` and receive shard assignments while exposing
 * `Sharding` and `Runners` services.
 *
 * **Details**
 *
 * It logs the bound `SocketServer.address` when the layer starts, formatting TCP
 * addresses as `hostname:port` and Unix socket addresses as their filesystem
 * path.
 *
 * **Gotchas**
 *
 * Although this layer serves runner RPCs with the provided `SocketServer`,
 * outgoing calls to other runners still require a `Runners.RpcClientProtocol`
 * service.
 *
 * @see {@link layerClientOnly} for the socket runner layer that only provides clients and does not receive shard assignments
 * @see {@link Runners.RpcClientProtocol} for the outgoing runner client protocol required by this layer
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  | Runners.RpcClientProtocol
  | ShardingConfig
  | RpcSerialization.RpcSerialization
  | SocketServer
  | MessageStorage
  | RunnerStorage.RunnerStorage
  | RunnerHealth
> = RunnerServer.layerWithClients.pipe(
  withLogAddress,
  Layer.provide(RpcServer.layerProtocolSocketServer)
)

/**
 * Provides a client-only socket runner layer that provides `Sharding` and `Runners` clients
 * without starting a runner server or receiving shard assignments.
 *
 * **When to use**
 *
 * Use to join a socket-based cluster as a client-only participant that can send
 * messages without hosting shards.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerClientOnly: Layer.Layer<
  Sharding.Sharding | Runners.Runners,
  never,
  Runners.RpcClientProtocol | ShardingConfig | MessageStorage | RunnerStorage.RunnerStorage
> = RunnerServer.layerClientOnly
