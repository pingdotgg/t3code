import * as Layer from "effect/Layer"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc"
import * as Socket from "effect/unstable/socket/Socket"
import { WsRpcGroup } from "@effect-http-ws-cli/server/contracts"

const wsUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/ws`
}

const protocolLayer = RpcClient.layerProtocolSocket({
  retryTransientErrors: true
}).pipe(
  Layer.provide(Socket.layerWebSocket(wsUrl())),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson)
)

export class TodoRpcClient extends AtomRpc.Service<TodoRpcClient>()("TodoRpcClient", {
  group: WsRpcGroup,
  protocol: protocolLayer
}) {}

export const todosSnapshotAtom = TodoRpcClient.query(
  "listTodos",
  { includeArchived: true }
)

export const subscribeTodosPullAtom = TodoRpcClient.query(
  "subscribeTodos",
  {
    fromOffset: 0,
    includeArchived: true
  }
)

export const renameTodoMutationAtom = TodoRpcClient.mutation("renameTodo")
export const completeTodoMutationAtom = TodoRpcClient.mutation("completeTodo")
export const archiveTodoMutationAtom = TodoRpcClient.mutation("archiveTodo")
