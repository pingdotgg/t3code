import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { KVNamespace } from "./KVNamespace.ts";

export class KVNamespaceError extends Data.TaggedError("KVNamespaceError")<{
  message: string;
  cause: Error;
}> {}

export interface KVNamespaceClient<Key extends string = string> {
  raw: Effect.Effect<runtime.KVNamespace, never, WorkerEnvironment>;
  get(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<string | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "text",
  ): Effect.Effect<string | null, KVNamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<ExpectedValue | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<ArrayBuffer | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "stream",
  ): Effect.Effect<ReadableStream | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<string | null, KVNamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<ExpectedValue | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<ArrayBuffer | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<ReadableStream | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<
    Map<string, string | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    Map<string, string | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    Map<string, string | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Effect.Effect<
    KVNamespaceListResult<Metadata, Key>,
    KVNamespaceError,
    RuntimeContext
  >;
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Effect.Effect<void, KVNamespaceError, RuntimeContext>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "text",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "stream",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  delete(key: Key): Effect.Effect<void, KVNamespaceError, RuntimeContext>;
}

export class KVNamespaceBinding extends Binding.Service<
  KVNamespaceBinding,
  (bucket: KVNamespace) => Effect.Effect<KVNamespaceClient>
>()("Cloudflare.KVNamespace") {}

export const KVNamespaceBindingLive = Layer.effect(
  KVNamespaceBinding,
  Effect.gen(function* () {
    const bind = yield* KVNamespaceBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (bucket: KVNamespace) {
      yield* bind(bucket);
      const raw = Effect.sync(
        // this must be lazy because the WorkerEnvironment is not available yet
        () => (env as Record<string, runtime.KVNamespace>)[bucket.LogicalId],
      );
      const tryPromise = <T>(
        fn: () => Promise<T>,
      ): Effect.Effect<T, KVNamespaceError> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new KVNamespaceError({
              message: error.message ?? "Unknown error",
              cause: error,
            }),
        });

      const use = <T>(
        fn: (raw: runtime.KVNamespace<string>) => Promise<T>,
      ): Effect.Effect<T, KVNamespaceError> =>
        raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

      // @ts-expect-error
      return {
        raw: raw,
        // @ts-expect-error
        get: (...args: Parameters<runtime.KVNamespace["get"]>) =>
          use((raw) => raw.get(...args)),
        // @ts-expect-error
        getWithMetadata: (
          ...args: Parameters<runtime.KVNamespace["getWithMetadata"]>
        ) => use((raw) => raw.getWithMetadata(...args)),
        // @ts-expect-error
        put: (...args: Parameters<runtime.KVNamespace["put"]>) =>
          use((raw) => raw.put(...args)),
        list: (...args: Parameters<runtime.KVNamespace["list"]>) =>
          use((raw) => raw.list(...args)),
        delete: (...args: Parameters<runtime.KVNamespace["delete"]>) =>
          use((raw) => raw.delete(...args)),
      } satisfies KVNamespaceClient as KVNamespaceClient;
    });
  }),
);

export class KVNamespaceBindingPolicy extends Binding.Policy<
  KVNamespaceBindingPolicy,
  (bucket: KVNamespace) => Effect.Effect<void>
>()("Cloudflare.KVNamespace") {}

export const KVNamespaceBindingPolicyLive =
  KVNamespaceBindingPolicy.layer.succeed(
    Effect.fn(function* (host: ResourceLike, namespace: KVNamespace) {
      if (isWorker(host)) {
        yield* host.bind`${namespace}`({
          bindings: [
            {
              type: "kv_namespace",
              name: namespace.LogicalId,
              namespaceId: namespace.namespaceId,
            },
          ],
        });
      } else {
        return yield* Effect.die(
          new Error(`BucketBinding does not support runtime '${host.Type}'`),
        );
      }
    }),
  );
