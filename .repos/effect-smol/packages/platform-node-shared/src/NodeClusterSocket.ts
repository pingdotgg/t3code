/**
 * Node TCP socket transport for Effect Cluster runner-to-runner RPC.
 *
 * This module provides the shared Node layers used by socket-based cluster
 * transports. `layerClientProtocol` opens TCP sockets to peer runner addresses
 * and wraps them in the current RPC serialization protocol. `layerSocketServer`
 * exposes the socket server that receives incoming runner RPC traffic.
 *
 * **Mental model**
 *
 * The cluster runtime decides which runners exist, which shards they own, and
 * which messages must be delivered. This module only provides the TCP transport
 * those services use after a runner address has been selected. The client side
 * dials an advertised runner address; the server side listens on the address
 * configured for the local runner.
 *
 * **Common tasks**
 *
 * Add these layers when a Node or Node-compatible cluster deployment should use
 * direct socket RPC instead of an HTTP transport. Configure `runnerAddress` as
 * the address other runners can reach, and configure `runnerListenAddress` when
 * the local process must bind a different host or port.
 *
 * **Gotchas**
 *
 * Containers, port mappings, and Kubernetes services often require different
 * advertised and listening addresses. Serialization is provided by the
 * surrounding layer, not by this module. A reachable socket confirms only that
 * TCP transport is available; gossip, shard ownership, health checks, and
 * persisted message notification are coordinated by the cluster services that
 * use this transport.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Runners from "effect/unstable/cluster/Runners"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { Socket } from "effect/unstable/socket/Socket"
import type * as SocketServer from "effect/unstable/socket/SocketServer"
import * as NodeSocket from "./NodeSocket.ts"
import * as NodeSocketServer from "./NodeSocketServer.ts"

/**
 * Provides the cluster `RpcClientProtocol` by opening TCP sockets to runner
 * addresses and using the current RPC serialization service.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerClientProtocol: Layer.Layer<
  Runners.RpcClientProtocol,
  never,
  RpcSerialization.RpcSerialization
> = Layer.effect(Runners.RpcClientProtocol)(
  Effect.gen(function*() {
    const serialization = yield* RpcSerialization.RpcSerialization
    return Effect.fnUntraced(function*(address) {
      const socket = yield* NodeSocket.makeNet({
        openTimeout: 1000,
        timeout: 5500,
        host: address.host,
        port: address.port
      })
      return yield* RpcClient.makeProtocolSocket().pipe(
        Effect.provideService(Socket, socket),
        Effect.provideService(RpcSerialization.RpcSerialization, serialization)
      )
    }, Effect.orDie)
  })
)

/**
 * Provides the socket server used by cluster runners, listening on
 * `ShardingConfig.runnerListenAddress` or `runnerAddress`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSocketServer: Layer.Layer<
  SocketServer.SocketServer,
  SocketServer.SocketServerError,
  ShardingConfig.ShardingConfig
> = Effect.gen(function*() {
  const config = yield* ShardingConfig.ShardingConfig
  const listenAddress = Option.orElse(config.runnerListenAddress, () => config.runnerAddress)
  if (Option.isNone(listenAddress)) {
    return yield* Effect.die("layerSocketServer: ShardingConfig.runnerListenAddress is None")
  }
  return NodeSocketServer.layer(listenAddress.value)
}).pipe(Layer.unwrap)
