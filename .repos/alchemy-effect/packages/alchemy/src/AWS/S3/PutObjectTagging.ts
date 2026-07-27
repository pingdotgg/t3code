import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectTaggingRequest extends Omit<
  S3.PutObjectTaggingRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:PutObjectTagging`.
 *
 * Bind this operation to a bucket to get a callable that replaces an object's
 * tag set — the bucket name is injected automatically and
 * `s3:PutObjectTagging`/`s3:PutObjectVersionTagging` are granted on the
 * bucket's objects. Provide the implementation with
 * `Effect.provide(AWS.S3.PutObjectTaggingHttp)`.
 * @binding
 * @section Object Tagging
 * @example Tag an Object
 * ```typescript
 * const putObjectTagging = yield* AWS.S3.PutObjectTagging(bucket);
 *
 * yield* putObjectTagging({
 *   Key: "reports/q3.csv",
 *   Tagging: { TagSet: [{ Key: "status", Value: "final" }] },
 * });
 * ```
 */
export interface PutObjectTagging extends Binding.Service<
  PutObjectTagging,
  "AWS.S3.PutObjectTagging",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectTaggingRequest,
    ) => Effect.Effect<S3.PutObjectTaggingOutput, S3.PutObjectTaggingError>
  >
> {}
export const PutObjectTagging = Binding.Service<PutObjectTagging>(
  "AWS.S3.PutObjectTagging",
);
