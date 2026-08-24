import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type { NamespaceError } from "./NamespaceTypes.ts";

/**
 * Bind a {@link Namespace} to a Worker with read access and obtain the
 * Effect-native KV client (`get`, `getWithMetadata`, `list`).
 *
 * `ReadNamespace` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.KV.ReadNamespace(ns)`.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export interface ReadNamespace extends Binding.Service<
  ReadNamespace,
  "Cloudflare.KV.ReadNamespace",
  (namespace: Namespace) => Effect.Effect<ReadNamespaceClient>
> {}

export const ReadNamespace = Binding.Service<ReadNamespace>(
  "Cloudflare.KV.ReadNamespace",
);

export interface ReadNamespaceClient<Key extends string = string> {
  raw: Effect.Effect<runtime.KVNamespace, never, RuntimeContext>;
  get(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<string | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "text",
  ): Effect.Effect<string | null, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<ExpectedValue | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<ArrayBuffer | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "stream",
  ): Effect.Effect<ReadableStream | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<string | null, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<ExpectedValue | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<ArrayBuffer | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<ReadableStream | null, NamespaceError, RuntimeContext>;
  get(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<Map<string, string | null>, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    NamespaceError,
    RuntimeContext
  >;
  get(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<Map<string, string | null>, NamespaceError, RuntimeContext>;
  get(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<Map<string, string | null>, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    NamespaceError,
    RuntimeContext
  >;
  list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Effect.Effect<
    KVNamespaceListResult<Metadata, Key>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "text",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "stream",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
}
