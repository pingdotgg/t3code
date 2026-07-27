import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
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
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export interface WriteNamespace extends Binding.Service<
  WriteNamespace,
  "Cloudflare.KV.WriteNamespace",
  (namespace: Namespace) => Effect.Effect<WriteNamespaceClient>
> {}

export const WriteNamespace = Binding.Service<WriteNamespace>(
  "Cloudflare.KV.WriteNamespace",
);

export interface WriteNamespaceClient<Key extends string = string> {
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Effect.Effect<void, NamespaceError, RuntimeContext>;
  delete(key: Key): Effect.Effect<void, NamespaceError, RuntimeContext>;
}
