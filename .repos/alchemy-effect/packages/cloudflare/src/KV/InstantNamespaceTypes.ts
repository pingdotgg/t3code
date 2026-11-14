import type * as runtime from "@cloudflare/workers-types";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NamespaceError } from "./NamespaceTypes.ts";
import type { ReadNamespaceClient } from "./ReadNamespace.ts";
import type { WriteNamespaceClient } from "./WriteNamespace.ts";

/** Instant lists all matching keys in one request; pagination is unsupported. */
export type InstantNamespaceListOptions = {
  prefix?: string;
  cursor?: never;
  limit?: never;
};

/** Instant supports the KV write options except metadata. */
export type InstantNamespacePutOptions = Omit<KVNamespacePutOptions, "metadata"> & {
  metadata?: never;
};

/** KV Instant read client. Use get: Instant does not store metadata. */
export interface ReadInstantNamespaceClient<Key extends string = string> extends Pick<
  ReadNamespaceClient<Key>,
  "get"
> {
  /** Returns all matching keys without pagination. */
  list(
    options?: InstantNamespaceListOptions,
  ): Effect.Effect<KVNamespaceListResult<unknown, Key>, NamespaceError, RuntimeContext>;
}

/** KV Instant write client; metadata cannot be attached to values. */
export interface WriteInstantNamespaceClient<Key extends string = string> extends Pick<
  WriteNamespaceClient<Key>,
  "delete"
> {
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: InstantNamespacePutOptions,
  ): Effect.Effect<void, NamespaceError, RuntimeContext>;
}

/** Combined read/write access to KV Instant. */
export interface ReadWriteInstantNamespaceClient<Key extends string = string>
  extends ReadInstantNamespaceClient<Key>, WriteInstantNamespaceClient<Key> {}

/** Native Worker env binding with Instant's metadata and pagination limits. */
export interface InstantNamespaceBindingClient extends Omit<
  runtime.KVNamespace,
  "put" | "list" | "getWithMetadata"
> {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: InstantNamespacePutOptions,
  ): Promise<void>;
  list(options?: InstantNamespaceListOptions): Promise<runtime.KVNamespaceListResult<unknown>>;
}
