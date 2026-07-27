import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectTaggingRequest extends Omit<
  S3.DeleteObjectTaggingRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:DeleteObjectTagging`.
 *
 * Bind this operation to a bucket to get a callable that removes an object's
 * entire tag set — the bucket name is injected automatically and
 * `s3:DeleteObjectTagging`/`s3:DeleteObjectVersionTagging` are granted on the
 * bucket's objects. Provide the implementation with
 * `Effect.provide(AWS.S3.DeleteObjectTaggingHttp)`.
 * @binding
 * @section Object Tagging
 * @example Remove All Tags from an Object
 * ```typescript
 * const deleteObjectTagging = yield* AWS.S3.DeleteObjectTagging(bucket);
 *
 * yield* deleteObjectTagging({ Key: "reports/q3.csv" });
 * ```
 */
export interface DeleteObjectTagging extends Binding.Service<
  DeleteObjectTagging,
  "AWS.S3.DeleteObjectTagging",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectTaggingRequest,
    ) => Effect.Effect<
      S3.DeleteObjectTaggingOutput,
      S3.DeleteObjectTaggingError
    >
  >
> {}
export const DeleteObjectTagging = Binding.Service<DeleteObjectTagging>(
  "AWS.S3.DeleteObjectTagging",
);
