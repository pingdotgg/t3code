import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectVersionsRequest extends Omit<
  S3.ListObjectVersionsRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:ListBucketVersions`.
 *
 * Bind this operation to a bucket to get a callable that lists object
 * versions and delete markers — the bucket name is injected automatically and
 * `s3:ListBucketVersions` is granted on the bucket. Provide the
 * implementation with `Effect.provide(AWS.S3.ListObjectVersionsHttp)`.
 * @binding
 * @section Listing Objects
 * @example List Versions Under a Prefix
 * ```typescript
 * const listObjectVersions = yield* AWS.S3.ListObjectVersions(bucket);
 *
 * const result = yield* listObjectVersions({ Prefix: "reports/" });
 * const versions = result.Versions ?? [];
 * ```
 */
export interface ListObjectVersions extends Binding.Service<
  ListObjectVersions,
  "AWS.S3.ListObjectVersions",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: ListObjectVersionsRequest,
    ) => Effect.Effect<S3.ListObjectVersionsOutput, S3.ListObjectVersionsError>
  >
> {}
export const ListObjectVersions = Binding.Service<ListObjectVersions>(
  "AWS.S3.ListObjectVersions",
);
