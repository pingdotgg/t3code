import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadBucket, type ReadBucketClient } from "./ReadBucket.ts";
import { makeStorageBinding, storageHttpLayer } from "./StorageBinding.ts";

export const makeReadBucketClient = (
  client: Effect.Success<
    ReturnType<Effect.Success<ReturnType<typeof makeStorageBinding>>>
  >,
): ReadBucketClient => ({
  get: client.get,
  head: client.head,
  list: client.list,
  presignGet: (key, options) => client.presign(key, "GET", options),
});

/**
 * Use injected same-branch Neon credentials, otherwise manage a scoped credential.
 *
 * @layer
 * @product Bucket
 * @provides ReadBucket
 */
export const ReadBucketHttp = Layer.effect(
  ReadBucket,
  makeStorageBinding("storage:read").pipe(
    Effect.map((bind) =>
      Effect.fn(function* (...args: Parameters<typeof bind>) {
        return makeReadBucketClient(yield* bind(...args));
      }),
    ),
  ),
).pipe(Layer.provide(storageHttpLayer));
