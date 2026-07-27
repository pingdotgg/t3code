import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectRequest extends Omit<
  S3.DeleteObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:DeleteObject`.
 *
 * Bind this operation to a bucket to get a callable that deletes objects —
 * the bucket name is injected automatically and `s3:DeleteObject` is granted
 * on the bucket. Provide the implementation with
 * `Effect.provide(AWS.S3.DeleteObjectHttp)`.
 * @binding
 * @section Deleting Objects
 * @example Delete an Object
 * ```typescript
 * // init — bind the operation to the bucket
 * const deleteObject = yield* AWS.S3.DeleteObject(bucket);
 *
 * // runtime — deleting a non-existent key succeeds (S3 delete is idempotent)
 * yield* deleteObject({ Key: "jobs/job-123.json" });
 * ```
 */
export interface DeleteObject extends Binding.Service<
  DeleteObject,
  "AWS.S3.DeleteObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectRequest,
    ) => Effect.Effect<S3.DeleteObjectOutput, S3.DeleteObjectError>
  >
> {}
export const DeleteObject = Binding.Service<DeleteObject>(
  "AWS.S3.DeleteObject",
);
