import { NodeSocket } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Stream from "effect/Stream"
import { WsRpcGroup } from "./contracts.ts"

export const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson)
  )

export const makeWsRpcClient = RpcClient.make(WsRpcGroup)
type WsRpcClient = typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never

export const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>
) =>
  makeWsRpcClient.pipe(
    Effect.flatMap(f),
    Effect.provide(wsRpcProtocolLayer(wsUrl))
  )

export const runClientExample = (wsUrl: string) =>
  Effect.scoped(
    withWsRpcClient(wsUrl, (client) =>
      Effect.gen(function*() {
      const echoed = yield* client.echo({ text: "hello from client" })
      const summed = yield* client.sum({ left: 20, right: 22 })
      const time = yield* client.time(undefined)
      return { echoed, summed, time }
      })
    )
  )

export const runSubscriptionExample = (wsUrl: string, modelId: string) =>
  Effect.scoped(
    withWsRpcClient(wsUrl, (client) =>
      Effect.gen(function*() {
        const snapshot = yield* client.listTodos({ includeArchived: true })
        const todo = snapshot.todos[0]
        if (!todo) {
          return []
        }

        yield* client.renameTodo({ id: todo.id, title: `${modelId}: first` })
        yield* client.completeTodo({ id: todo.id, completed: true })

        return yield* client.subscribeTodos({ fromOffset: snapshot.offset, includeArchived: true }).pipe(
          Stream.take(2),
          Stream.runCollect
        )
      })
    )
  )
