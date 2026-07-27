import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

/**
 * Shared domain + RPC contract.
 *
 * This module is the single source of truth imported by BOTH ends:
 *   - the backend `Cloudflare.Workers.RpcWorker` ({@link ./api.ts}) serves it, and
 *   - the browser `AtomRpc` client ({@link ./rpc-client.ts}) consumes it.
 *
 * One `Schema` codec round-trips every value over the wire, so the React UI is
 * fully typed against the same shapes the Postgres-backed handlers return.
 */

/** A single todo item, encoded over the wire and decoded back into this class. */
export class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.Number,
  text: Schema.String,
  done: Schema.Boolean,
  createdAt: Schema.Date,
}) {}

/** Raised when a mutation targets a todo id that no longer exists. */
export class TodoNotFound extends Schema.TaggedErrorClass<TodoNotFound>()(
  "TodoNotFound",
  { message: Schema.String, id: Schema.Number },
) {}

export class TodoRpcs extends RpcGroup.make(
  Rpc.make("listTodos", {
    success: Schema.Array(Todo),
  }),
  Rpc.make("createTodo", {
    payload: { text: Schema.String },
    success: Todo,
  }),
  Rpc.make("toggleTodo", {
    payload: { id: Schema.Number, done: Schema.Boolean },
    success: Todo,
    error: TodoNotFound,
  }),
  Rpc.make("deleteTodo", {
    payload: { id: Schema.Number },
    success: Schema.Number,
    error: TodoNotFound,
  }),
) {}
