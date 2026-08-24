import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRetentionRequest extends Omit<
  S3.GetObjectRetentionRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:GetObjectRetention`.
 *
 * Bind this operation to a bucket to get a callable that reads an object's
 * Object Lock retention settings — the bucket name is injected automatically
 * and `s3:GetObjectRetention` is granted on the bucket's objects. Requires a
 * bucket created with `objectLockEnabled: true`. Provide the implementation
 * with `Effect.provide(AWS.S3.GetObjectRetentionHttp)`.
 * @binding
 * @section Object Lock
 * @example Read an Object's Retention
 * ```typescript
 * const getObjectRetention = yield* AWS.S3.GetObjectRetention(bucket);
 *
 * const { Retention } = yield* getObjectRetention({ Key: "records/1.json" });
 * ```
 */
export interface GetObjectRetention extends Binding.Service<
  GetObjectRetention,
  "AWS.S3.GetObjectRetention",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRetentionRequest,
    ) => Effect.Effect<S3.GetObjectRetentionOutput, S3.GetObjectRetentionError>
  >
> {}
export const GetObjectRetention = Binding.Service<GetObjectRetention>(
  "AWS.S3.GetObjectRetention",
);
