import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartRequest extends Omit<
  S3.UploadPartRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:UploadPart`.
 *
 * Uploads one part of a multipart upload started with
 * `CreateMultipartUpload`. Keep each part's returned `ETag` — the final
 * `CompleteMultipartUpload` call needs the full `{ ETag, PartNumber }` list.
 * Provide the implementation with `Effect.provide(AWS.S3.UploadPartHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example Upload a Part
 * ```typescript
 * // init — bind the operation to the bucket
 * const uploadPart = yield* AWS.S3.UploadPart(bucket);
 *
 * // runtime — PartNumber is 1-based; collect the ETag for completion
 * const part = yield* uploadPart({
 *   Key: "backups/archive.tar",
 *   UploadId,
 *   PartNumber: 1,
 *   Body: chunk, // 5 MiB–5 GiB except the last part
 * });
 * parts.push({ ETag: part.ETag, PartNumber: 1 });
 * ```
 */
export interface UploadPart extends Binding.Service<
  UploadPart,
  "AWS.S3.UploadPart",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: UploadPartRequest,
    ) => Effect.Effect<S3.UploadPartOutput, S3.UploadPartError>
  >
> {}
export const UploadPart = Binding.Service<UploadPart>("AWS.S3.UploadPart");
