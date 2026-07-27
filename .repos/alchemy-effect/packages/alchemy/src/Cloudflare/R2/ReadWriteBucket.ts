import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "Cloudflare.R2.ReadWriteBucket",
  (bucket: Bucket) => Effect.Effect<ReadWriteBucketClient>
> {}

export const ReadWriteBucket = Binding.Service<ReadWriteBucket>(
  "Cloudflare.R2.ReadWriteBucket",
);

export interface ReadWriteBucketClient
  extends ReadBucketClient, WriteBucketClient {}
