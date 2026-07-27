import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CompleteMultipartUploadRequest extends Omit<
  S3.CompleteMultipartUploadRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:CompleteMultipartUpload`.
 *
 * Assembles the parts uploaded with `UploadPart` into the final object. The
 * part list must be in ascending `PartNumber` order with the `ETag` each
 * `UploadPart` call returned. Provide the implementation with
 * `Effect.provide(AWS.S3.CompleteMultipartUploadHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example Complete a Multipart Upload
 * ```typescript
 * // init — bind the operation to the bucket
 * const completeUpload = yield* AWS.S3.CompleteMultipartUpload(bucket);
 *
 * // runtime — parts collected from each AWS.S3.UploadPart call
 * yield* completeUpload({
 *   Key: "backups/archive.tar",
 *   UploadId,
 *   MultipartUpload: {
 *     Parts: [
 *       { ETag: part1.ETag, PartNumber: 1 },
 *       { ETag: part2.ETag, PartNumber: 2 },
 *     ],
 *   },
 * });
 * ```
 */
export interface CompleteMultipartUpload extends Binding.Service<
  CompleteMultipartUpload,
  "AWS.S3.CompleteMultipartUpload",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CompleteMultipartUploadRequest,
    ) => Effect.Effect<
      S3.CompleteMultipartUploadOutput,
      S3.CompleteMultipartUploadError
    >
  >
> {}

export const CompleteMultipartUpload = Binding.Service<CompleteMultipartUpload>(
  "AWS.S3.CompleteMultipartUpload",
);
