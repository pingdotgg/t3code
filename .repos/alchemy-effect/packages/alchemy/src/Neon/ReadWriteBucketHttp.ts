import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadWriteBucket } from "./ReadWriteBucket.ts";
import { makeReadBucketClient } from "./ReadBucketHttp.ts";
import { makeWriteBucketClient } from "./WriteBucketHttp.ts";
import { makeStorageBinding, storageHttpLayer } from "./StorageBinding.ts";

/**
 * One injected or managed credential for both interfaces.
 *
 * @layer
 * @product Bucket
 * @provides ReadWriteBucket
 */
export const ReadWriteBucketHttp = Layer.effect(
  ReadWriteBucket,
  makeStorageBinding("storage:write").pipe(
    Effect.map((bind) =>
      Effect.fn(function* (...args: Parameters<typeof bind>) {
        const client = yield* bind(...args);
        return {
          ...makeReadBucketClient(client),
          ...makeWriteBucketClient(client),
        };
      }),
    ),
  ),
).pipe(Layer.provide(storageHttpLayer));
