import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartCopyRequest extends Omit<
  S3.UploadPartCopyRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:UploadPartCopy`.
 *
 * Bind this operation to a bucket to get a callable that uploads a multipart
 * part by copying from an existing object — the destination bucket name is
 * injected automatically and `s3:PutObject`/`s3:GetObject` are granted on the
 * bucket's objects. Copying from a *different* source bucket additionally
 * requires read access to that bucket (bind `GetObject` on it). Provide the
 * implementation with `Effect.provide(AWS.S3.UploadPartCopyHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example Copy an Existing Object as a Part
 * ```typescript
 * const uploadPartCopy = yield* AWS.S3.UploadPartCopy(bucket);
 *
 * const part = yield* uploadPartCopy({
 *   Key: "combined.bin",
 *   UploadId: uploadId,
 *   PartNumber: 1,
 *   CopySource: `${bucketName}/source.bin`,
 * });
 * ```
 */
export interface UploadPartCopy extends Binding.Service<
  UploadPartCopy,
  "AWS.S3.UploadPartCopy",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: UploadPartCopyRequest,
    ) => Effect.Effect<S3.UploadPartCopyOutput, S3.UploadPartCopyError>
  >
> {}
export const UploadPartCopy = Binding.Service<UploadPartCopy>(
  "AWS.S3.UploadPartCopy",
);
