import * as Schema from "effect/Schema"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

export const EchoPayload = Schema.Struct({
  text: Schema.String
})

export const EchoResult = Schema.Struct({
  text: Schema.String
})

export const SumPayload = Schema.Struct({
  left: Schema.Number,
  right: Schema.Number
})

export const SumResult = Schema.Struct({
  total: Schema.Number
})

export const TimeResult = Schema.Struct({
  iso: Schema.String
})

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  archived: Schema.Boolean,
  revision: Schema.Number,
  updatedAt: Schema.String
})
export type Todo = Schema.Schema.Type<typeof Todo>

export const TodoChange = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("TodoCreated")
  }),
  Schema.Struct({
    _tag: Schema.Literal("TodoRenamed"),
    title: Schema.String
  }),
  Schema.Struct({
    _tag: Schema.Literal("TodoCompleted"),
    completed: Schema.Boolean
  }),
  Schema.Struct({
    _tag: Schema.Literal("TodoArchived"),
    archived: Schema.Boolean
  })
])
export type TodoChange = Schema.Schema.Type<typeof TodoChange>

export const TodoEvent = Schema.Struct({
  offset: Schema.Number,
  at: Schema.String,
  todo: Todo,
  change: TodoChange
})
export type TodoEvent = Schema.Schema.Type<typeof TodoEvent>

export const TodoSnapshot = Schema.Struct({
  offset: Schema.Number,
  todos: Schema.Array(Todo)
})
export type TodoSnapshot = Schema.Schema.Type<typeof TodoSnapshot>

export const EchoRpc = Rpc.make("echo", {
  payload: EchoPayload,
  success: EchoResult
})

export const SumRpc = Rpc.make("sum", {
  payload: SumPayload,
  success: SumResult
})

export const TimeRpc = Rpc.make("time", {
  success: TimeResult
})

export const ListTodosRpc = Rpc.make("listTodos", {
  payload: Schema.Struct({
    includeArchived: Schema.Boolean
  }),
  success: TodoSnapshot
})

export const RenameTodoRpc = Rpc.make("renameTodo", {
  payload: Schema.Struct({
    id: Schema.String,
    title: Schema.String
  }),
  success: TodoEvent
})

export const CompleteTodoRpc = Rpc.make("completeTodo", {
  payload: Schema.Struct({
    id: Schema.String,
    completed: Schema.Boolean
  }),
  success: TodoEvent
})

export const ArchiveTodoRpc = Rpc.make("archiveTodo", {
  payload: Schema.Struct({
    id: Schema.String,
    archived: Schema.Boolean
  }),
  success: TodoEvent
})

export const SubscribeTodosRpc = Rpc.make("subscribeTodos", {
  payload: Schema.Struct({
    fromOffset: Schema.Number,
    includeArchived: Schema.Boolean
  }),
  success: TodoEvent,
  stream: true
})

export const WsRpcGroup = RpcGroup.make(
  EchoRpc,
  SumRpc,
  TimeRpc,
  ListTodosRpc,
  RenameTodoRpc,
  CompleteTodoRpc,
  ArchiveTodoRpc,
  SubscribeTodosRpc
)
