import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectLegalHoldRequest extends Omit<
  S3.PutObjectLegalHoldRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:PutObjectLegalHold`.
 *
 * Bind this operation to a bucket to get a callable that applies or removes
 * a legal hold on an object — the bucket name is injected automatically and
 * `s3:PutObjectLegalHold` is granted on the bucket's objects. Requires a
 * bucket created with `objectLockEnabled: true`. Provide the implementation
 * with `Effect.provide(AWS.S3.PutObjectLegalHoldHttp)`.
 * @binding
 * @section Object Lock
 * @example Place and Release a Legal Hold
 * ```typescript
 * const putObjectLegalHold = yield* AWS.S3.PutObjectLegalHold(bucket);
 *
 * yield* putObjectLegalHold({
 *   Key: "records/1.json",
 *   LegalHold: { Status: "ON" },
 * });
 * // … later, release it so the object can be deleted
 * yield* putObjectLegalHold({
 *   Key: "records/1.json",
 *   LegalHold: { Status: "OFF" },
 * });
 * ```
 */
export interface PutObjectLegalHold extends Binding.Service<
  PutObjectLegalHold,
  "AWS.S3.PutObjectLegalHold",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectLegalHoldRequest,
    ) => Effect.Effect<S3.PutObjectLegalHoldOutput, S3.PutObjectLegalHoldError>
  >
> {}
export const PutObjectLegalHold = Binding.Service<PutObjectLegalHold>(
  "AWS.S3.PutObjectLegalHold",
);
