import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CreateMultipartUploadRequest extends Omit<
  S3.CreateMultipartUploadRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:CreateMultipartUpload`.
 *
 * Starts a multipart upload and returns the `UploadId` that `UploadPart`,
 * `CompleteMultipartUpload`, and `AbortMultipartUpload` reference. Use it for
 * objects too large for a single `PutObject` (parts are 5 MiB–5 GiB, uploaded
 * independently and in parallel). Provide the implementation with
 * `Effect.provide(AWS.S3.CreateMultipartUploadHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example Start a Multipart Upload
 * ```typescript
 * // init — bind the operation to the bucket
 * const createUpload = yield* AWS.S3.CreateMultipartUpload(bucket);
 *
 * // runtime — object-level metadata (ContentType, etc.) is set here,
 * // not on the individual parts
 * const { UploadId } = yield* createUpload({
 *   Key: "backups/archive.tar",
 *   ContentType: "application/x-tar",
 * });
 * // pass UploadId to AWS.S3.UploadPart / CompleteMultipartUpload
 * ```
 */
export interface CreateMultipartUpload extends Binding.Service<
  CreateMultipartUpload,
  "AWS.S3.CreateMultipartUpload",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CreateMultipartUploadRequest,
    ) => Effect.Effect<
      S3.CreateMultipartUploadOutput,
      S3.CreateMultipartUploadError
    >
  >
> {}

export const CreateMultipartUpload = Binding.Service<CreateMultipartUpload>(
  "AWS.S3.CreateMultipartUpload",
);
