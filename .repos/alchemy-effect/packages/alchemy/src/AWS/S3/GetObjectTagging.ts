import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectTaggingRequest extends Omit<
  S3.GetObjectTaggingRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:GetObjectTagging`.
 *
 * Bind this operation to a bucket to get a callable that reads an object's
 * tag set — the bucket name is injected automatically and
 * `s3:GetObjectTagging`/`s3:GetObjectVersionTagging` are granted on the
 * bucket's objects. Provide the implementation with
 * `Effect.provide(AWS.S3.GetObjectTaggingHttp)`.
 * @binding
 * @section Object Tagging
 * @example Read an Object's Tags
 * ```typescript
 * const getObjectTagging = yield* AWS.S3.GetObjectTagging(bucket);
 *
 * const { TagSet } = yield* getObjectTagging({ Key: "reports/q3.csv" });
 * ```
 */
export interface GetObjectTagging extends Binding.Service<
  GetObjectTagging,
  "AWS.S3.GetObjectTagging",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectTaggingRequest,
    ) => Effect.Effect<S3.GetObjectTaggingOutput, S3.GetObjectTaggingError>
  >
> {}
export const GetObjectTagging = Binding.Service<GetObjectTagging>(
  "AWS.S3.GetObjectTagging",
);
