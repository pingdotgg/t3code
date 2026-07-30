import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectsV2Request extends Omit<
  S3.ListObjectsV2Request,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:ListObjectsV2`.
 *
 * Bind this operation to a bucket to get a callable that lists objects —
 * the bucket name is injected automatically and `s3:ListBucket` is granted
 * on the bucket. Provide the implementation with
 * `Effect.provide(AWS.S3.ListObjectsV2Http)`.
 * @binding
 * @section Listing Objects
 * @example List Objects Under a Prefix
 * ```typescript
 * // init — bind the operation to the bucket
 * const listObjects = yield* AWS.S3.ListObjectsV2(bucket);
 *
 * // runtime — list up to 100 keys under `jobs/`
 * const result = yield* listObjects({ Prefix: "jobs/", MaxKeys: 100 });
 * const keys = (result.Contents ?? []).map((object) => object.Key);
 * // result.IsTruncated + result.NextContinuationToken page through the rest
 * ```
 */
export interface ListObjectsV2 extends Binding.Service<
  ListObjectsV2,
  "AWS.S3.ListObjectsV2",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: ListObjectsV2Request,
    ) => Effect.Effect<S3.ListObjectsV2Output, S3.ListObjectsV2Error>
  >
> {}

export const ListObjectsV2 = Binding.Service<ListObjectsV2>(
  "AWS.S3.ListObjectsV2",
);
