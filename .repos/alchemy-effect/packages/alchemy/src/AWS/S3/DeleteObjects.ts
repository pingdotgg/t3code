import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectsRequest extends Omit<
  S3.DeleteObjectsRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:DeleteObjects` (batch delete).
 *
 * Bind this operation to a bucket to get a callable that deletes up to 1,000
 * objects in a single request — the bucket name is injected automatically and
 * `s3:DeleteObject`/`s3:DeleteObjectVersion` are granted on the bucket's
 * objects. Provide the implementation with
 * `Effect.provide(AWS.S3.DeleteObjectsHttp)`.
 * @binding
 * @section Deleting Objects
 * @example Delete Several Objects at Once
 * ```typescript
 * // init — bind the operation to the bucket
 * const deleteObjects = yield* AWS.S3.DeleteObjects(bucket);
 *
 * // runtime — per-key failures are reported in `Errors`, not thrown
 * const result = yield* deleteObjects({
 *   Delete: {
 *     Objects: [{ Key: "a.txt" }, { Key: "b.txt" }],
 *     Quiet: true,
 *   },
 * });
 * ```
 */
export interface DeleteObjects extends Binding.Service<
  DeleteObjects,
  "AWS.S3.DeleteObjects",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectsRequest,
    ) => Effect.Effect<S3.DeleteObjectsOutput, S3.DeleteObjectsError>
  >
> {}
export const DeleteObjects = Binding.Service<DeleteObjects>(
  "AWS.S3.DeleteObjects",
);
