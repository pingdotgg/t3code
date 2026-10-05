import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

export interface ReadWriteBucketClient
  extends ReadBucketClient, WriteBucketClient {}

/**
 * Read and write access to a Cloud Storage {@link Bucket}. Grants
 * `roles/storage.objectUser` on the bucket only.
 *
 * ### Reading and writing
 * **Example:** Copy within a bucket
 * ```typescript
 * const files = yield* GCP.Storage.ReadWriteBucket(bucket);
 * const source = yield* files.get("in.txt");
 * if (source) yield* files.put("out.txt", source.body);
 * // …provided with Effect.provide(GCP.Storage.ReadWriteBucketHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "GCP.Storage.ReadWriteBucket",
  (bucket: Bucket) => Effect.Effect<ReadWriteBucketClient>
> {}

export const ReadWriteBucket = Binding.Service<ReadWriteBucket>(
  "GCP.Storage.ReadWriteBucket",
);
