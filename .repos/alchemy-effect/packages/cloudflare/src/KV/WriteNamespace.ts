import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { InstantNamespace } from "./InstantNamespace.ts";
import type { WriteInstantNamespaceClient } from "./InstantNamespaceTypes.ts";
import type { Namespace } from "./Namespace.ts";
import type { NamespaceError } from "./NamespaceTypes.ts";

/**
 * Bind a {@link Namespace} to a Worker with write access and obtain the
 * Effect-native KV client (`put`, `delete`).
 *
 * `WriteNamespace` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.KV.WriteNamespace(ns)`.
 *
 * Also accepts InstantNamespace, returning a client without metadata or
 * paginated listing options.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export interface WriteNamespace extends Binding.Service<
  WriteNamespace,
  "Cloudflare.KV.WriteNamespace",
  {
    (namespace: InstantNamespace): Effect.Effect<WriteInstantNamespaceClient>;
    (namespace: Namespace): Effect.Effect<WriteNamespaceClient>;
    (namespace: Namespace | InstantNamespace): Effect.Effect<WriteInstantNamespaceClient>;
  }
> {
  <Req = never>(
    namespace: Input<Namespace> | Effect.Effect<Namespace, never, Req>,
  ): Effect.Effect<WriteNamespaceClient, never, WriteNamespace | Req>;
  <Req = never>(
    namespace:
      | Input<Namespace | InstantNamespace>
      | Effect.Effect<Namespace | InstantNamespace, never, Req>,
  ): Effect.Effect<WriteInstantNamespaceClient, never, WriteNamespace | Req>;
}

export const WriteNamespace = Binding.Service<WriteNamespace>("Cloudflare.KV.WriteNamespace");

export interface WriteNamespaceClient<Key extends string = string> {
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Effect.Effect<void, NamespaceError, RuntimeContext>;
  delete(key: Key): Effect.Effect<void, NamespaceError, RuntimeContext>;
}
