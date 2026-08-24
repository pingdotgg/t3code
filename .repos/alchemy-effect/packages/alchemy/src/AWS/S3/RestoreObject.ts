import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface RestoreObjectRequest extends Omit<
  S3.RestoreObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:RestoreObject`.
 *
 * Bind this operation to a bucket to get a callable that initiates a restore
 * of an archived (Glacier / Deep Archive) object — the bucket name is
 * injected automatically and `s3:RestoreObject` is granted on the bucket's
 * objects. Provide the implementation with
 * `Effect.provide(AWS.S3.RestoreObjectHttp)`.
 * @binding
 * @section Archived Objects
 * @example Restore an Archived Object for 3 Days
 * ```typescript
 * const restoreObject = yield* AWS.S3.RestoreObject(bucket);
 *
 * yield* restoreObject({
 *   Key: "archive/2024.tar",
 *   RestoreRequest: {
 *     Days: 3,
 *     GlacierJobParameters: { Tier: "Standard" },
 *   },
 * });
 * ```
 */
export interface RestoreObject extends Binding.Service<
  RestoreObject,
  "AWS.S3.RestoreObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: RestoreObjectRequest,
    ) => Effect.Effect<S3.RestoreObjectOutput, S3.RestoreObjectError>
  >
> {}
export const RestoreObject = Binding.Service<RestoreObject>(
  "AWS.S3.RestoreObject",
);
