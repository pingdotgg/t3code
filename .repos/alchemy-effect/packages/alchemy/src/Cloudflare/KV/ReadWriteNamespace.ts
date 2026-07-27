import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
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
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export interface ReadWriteNamespace extends Binding.Service<
  ReadWriteNamespace,
  "Cloudflare.KVNamespace.ReadWrite",
  (namespace: Namespace) => Effect.Effect<ReadWriteNamespaceClient>
> {}

export const ReadWriteNamespace = Binding.Service<ReadWriteNamespace>(
  "Cloudflare.KVNamespace.ReadWrite",
);

export interface ReadWriteNamespaceClient<Key extends string = string>
  extends ReadNamespaceClient<Key>, WriteNamespaceClient<Key> {}
