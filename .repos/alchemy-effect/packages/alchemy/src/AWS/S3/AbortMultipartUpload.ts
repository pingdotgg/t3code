import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface AbortMultipartUploadRequest extends Omit<
  S3.AbortMultipartUploadRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:AbortMultipartUpload`.
 *
 * Discards an in-progress multipart upload and frees the storage its parts
 * consume — abandoned uploads keep billing until aborted (or expired by a
 * lifecycle rule). Provide the implementation with
 * `Effect.provide(AWS.S3.AbortMultipartUploadHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example Abort an Upload When Part Uploads Fail
 * ```typescript
 * // init — bind the operation to the bucket
 * const abortUpload = yield* AWS.S3.AbortMultipartUpload(bucket);
 *
 * // runtime — clean up if the part-upload pipeline fails
 * yield* uploadAllParts.pipe(
 *   Effect.tapError(() =>
 *     abortUpload({ Key: "backups/archive.tar", UploadId }),
 *   ),
 * );
 * ```
 */
export interface AbortMultipartUpload extends Binding.Service<
  AbortMultipartUpload,
  "AWS.S3.AbortMultipartUpload",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: AbortMultipartUploadRequest,
    ) => Effect.Effect<
      S3.AbortMultipartUploadOutput,
      S3.AbortMultipartUploadError
    >
  >
> {}

export const AbortMultipartUpload = Binding.Service<AbortMultipartUpload>(
  "AWS.S3.AbortMultipartUpload",
);
