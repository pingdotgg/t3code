import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { StorageBindingOptions } from "./StorageBinding.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

export interface ReadWriteBucketClient extends ReadBucketClient, WriteBucketClient {}
/**
 * Read and mutate a bucket with one credential granting storage:read and
 * storage:write, or the Function's injected credentials. No per-bucket policy
 * is manufactured.
 *
 * ### Read and Write
 * **Example:** Bind uploads during Function initialization
 * ```typescript
 * const files = yield* Neon.ReadWriteBucket(uploads);
 * ```
 *
 * @binding
 * @product Bucket
 */
export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "Neon.ReadWriteBucket",
  (bucket: Bucket, options?: StorageBindingOptions) => Effect.Effect<ReadWriteBucketClient>
> {}
export const ReadWriteBucket = Binding.Service<ReadWriteBucket>("Neon.ReadWriteBucket");
