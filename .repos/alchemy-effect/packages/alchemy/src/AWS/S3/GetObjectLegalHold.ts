import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectLegalHoldRequest extends Omit<
  S3.GetObjectLegalHoldRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:GetObjectLegalHold`.
 *
 * Bind this operation to a bucket to get a callable that reads an object's
 * legal-hold status — the bucket name is injected automatically and
 * `s3:GetObjectLegalHold` is granted on the bucket's objects. Requires a
 * bucket created with `objectLockEnabled: true`. Provide the implementation
 * with `Effect.provide(AWS.S3.GetObjectLegalHoldHttp)`.
 * @binding
 * @section Object Lock
 * @example Read an Object's Legal-Hold Status
 * ```typescript
 * const getObjectLegalHold = yield* AWS.S3.GetObjectLegalHold(bucket);
 *
 * const { LegalHold } = yield* getObjectLegalHold({ Key: "records/1.json" });
 * ```
 */
export interface GetObjectLegalHold extends Binding.Service<
  GetObjectLegalHold,
  "AWS.S3.GetObjectLegalHold",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectLegalHoldRequest,
    ) => Effect.Effect<S3.GetObjectLegalHoldOutput, S3.GetObjectLegalHoldError>
  >
> {}
export const GetObjectLegalHold = Binding.Service<GetObjectLegalHold>(
  "AWS.S3.GetObjectLegalHold",
);
