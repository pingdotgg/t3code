/**
 * In-memory test harness for RPC groups.
 *
 * `RpcTest` connects a generated client directly to `RpcServer` handlers for
 * the same `RpcGroup`. It uses the no-serialization path, so requests,
 * responses, stream chunks, acknowledgements, interrupts, headers, and
 * middleware metadata travel through the normal client/server machinery without
 * opening HTTP, socket, worker, or serializer infrastructure.
 *
 * **Mental model**
 *
 * `makeClient` builds an in-memory server, wires the client and server write
 * callbacks together, and returns the scoped generated client. The handlers,
 * server middleware, client middleware, and `Scope` still come from the Effect
 * environment just as they would for a real transport; only the byte-level
 * protocol is skipped.
 *
 * **Common tasks**
 *
 * Use this module for tests that should exercise RPC routing, handler lookup,
 * middleware, headers, typed errors, interruptions, and streaming behavior
 * quickly. Use a real transport plus `RpcSerialization` coverage when you need
 * to test HTTP status handling, socket framing, worker transferables, schema
 * encoding or decoding, or wire compatibility.
 *
 * **Gotchas**
 *
 * Because no serialization happens, invalid wire payloads and mismatched codecs
 * will not be discovered here. The client is scoped to the in-memory
 * connection; acquire it inside a scoped test or provide `Scope` explicitly.
 * The `flatten` option matches `RpcClient.makeNoSerialization`, and
 * acknowledgements are enabled to mirror the bidirectional streaming protocol.
 *
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import type * as Scope from "../../Scope.ts"
import type * as Rpc from "./Rpc.ts"
import * as RpcClient from "./RpcClient.ts"
import type * as RpcGroup from "./RpcGroup.ts"
import * as RpcServer from "./RpcServer.ts"

/**
 * Creates an in-memory RPC client for a group, backed by the group's handlers
 * from the environment and using the no-serialization test transport.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeClient: <Rpcs extends Rpc.Any, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    readonly flatten?: Flatten | undefined
  }
) => Effect.Effect<
  Flatten extends true ? RpcClient.RpcClient.Flat<Rpcs> : RpcClient.RpcClient<Rpcs>,
  never,
  Scope.Scope | Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs> | Rpc.MiddlewareClient<Rpcs>
> = Effect.fnUntraced(function*<Rpcs extends Rpc.Any, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    readonly flatten?: Flatten | undefined
  }
) {
  // oxlint-disable-next-line prefer-const
  let client!: Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never, Flatten>>>
  const server = yield* RpcServer.makeNoSerialization(group, {
    onFromServer(response) {
      return client.write(response)
    }
  })
  client = yield* RpcClient.makeNoSerialization(group, {
    supportsAck: true,
    flatten: options?.flatten,
    onFromClient({ message }) {
      return server.write(0, message)
    }
  })
  return client.client
})
