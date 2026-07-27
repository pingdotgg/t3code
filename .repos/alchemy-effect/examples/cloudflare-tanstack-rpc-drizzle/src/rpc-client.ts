import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { TodoRpcs } from "./backend/rpc.ts";

/**
 * The browser-side reactive RPC client. Effect 4 ships atom RPC natively in
 * `effect/unstable/reactivity/AtomRpc` — `AtomRpc.Service` turns an `RpcGroup`
 * into a `.query()` / `.mutation()` client whose results are atoms.
 *
 * The transport (`protocol`) is a plain HTTP client over `fetch`, pointed at
 * the same-origin `/rpc` route which proxies to the backend service binding.
 * Serialization MUST match the backend (`RpcSerialization.layerJson`).
 */
export class TodoClient extends AtomRpc.Service<TodoClient>()("TodoClient", {
  group: TodoRpcs,
  protocol: RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerJson),
  ),
}) {}

/**
 * Query/mutation atoms, created once at module scope so their identity is stable
 * across renders. `reactivityKeys: ["todos"]` ties the list query to the
 * mutations below — when a mutation runs with the same key, the list refetches.
 */
export const listTodosAtom = TodoClient.query("listTodos", undefined, {
  reactivityKeys: ["todos"],
});
export const createTodoAtom = TodoClient.mutation("createTodo");
export const toggleTodoAtom = TodoClient.mutation("toggleTodo");
export const deleteTodoAtom = TodoClient.mutation("deleteTodo");
