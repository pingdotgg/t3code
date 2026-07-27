import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRetentionRequest extends Omit<
  S3.PutObjectRetentionRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:PutObjectRetention`.
 *
 * Bind this operation to a bucket to get a callable that places an Object
 * Lock retention configuration on an object — the bucket name is injected
 * automatically and `s3:PutObjectRetention` is granted on the bucket's
 * objects. Requires a bucket created with `objectLockEnabled: true`;
 * bypassing a GOVERNANCE retention additionally requires
 * `s3:BypassGovernanceRetention`. Provide the implementation with
 * `Effect.provide(AWS.S3.PutObjectRetentionHttp)`.
 * @binding
 * @section Object Lock
 * @example Retain an Object in GOVERNANCE Mode
 * ```typescript
 * const putObjectRetention = yield* AWS.S3.PutObjectRetention(bucket);
 *
 * yield* putObjectRetention({
 *   Key: "records/1.json",
 *   Retention: {
 *     Mode: "GOVERNANCE",
 *     RetainUntilDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
 *   },
 * });
 * ```
 */
export interface PutObjectRetention extends Binding.Service<
  PutObjectRetention,
  "AWS.S3.PutObjectRetention",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRetentionRequest,
    ) => Effect.Effect<S3.PutObjectRetentionOutput, S3.PutObjectRetentionError>
  >
> {}
export const PutObjectRetention = Binding.Service<PutObjectRetention>(
  "AWS.S3.PutObjectRetention",
);
