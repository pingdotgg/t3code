import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import type { InstantNamespace } from "./InstantNamespace.ts";
import type { ReadWriteInstantNamespaceClient } from "./InstantNamespaceTypes.ts";
import type { Namespace } from "./Namespace.ts";
import type { ReadNamespaceClient } from "./ReadNamespace.ts";
import type { WriteNamespaceClient } from "./WriteNamespace.ts";

/**
 * Bind a {@link Namespace} to a Worker with read + write access and obtain
 * the Effect-native KV client (`get`, `getWithMetadata`, `list`, `put`,
 * `delete`).
 *
 * `ReadWriteNamespace` is a single identifier that is simultaneously the
 * binding's Context tag, its type, and the callable —
 * `yield* Cloudflare.KV.ReadWriteNamespace(ns)`.
 *
 * Also accepts InstantNamespace, returning a client without metadata or
 * paginated listing options.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export interface ReadWriteNamespace extends Binding.Service<
  ReadWriteNamespace,
  "Cloudflare.KVNamespace.ReadWrite",
  {
    (namespace: InstantNamespace): Effect.Effect<ReadWriteInstantNamespaceClient>;
    (namespace: Namespace): Effect.Effect<ReadWriteNamespaceClient>;
    (namespace: Namespace | InstantNamespace): Effect.Effect<ReadWriteInstantNamespaceClient>;
  }
> {
  <Req = never>(
    namespace: Input<Namespace> | Effect.Effect<Namespace, never, Req>,
  ): Effect.Effect<ReadWriteNamespaceClient, never, ReadWriteNamespace | Req>;
  <Req = never>(
    namespace:
      | Input<Namespace | InstantNamespace>
      | Effect.Effect<Namespace | InstantNamespace, never, Req>,
  ): Effect.Effect<ReadWriteInstantNamespaceClient, never, ReadWriteNamespace | Req>;
}

export const ReadWriteNamespace = Binding.Service<ReadWriteNamespace>(
  "Cloudflare.KVNamespace.ReadWrite",
);

export interface ReadWriteNamespaceClient<Key extends string = string>
  extends ReadNamespaceClient<Key>, WriteNamespaceClient<Key> {}
