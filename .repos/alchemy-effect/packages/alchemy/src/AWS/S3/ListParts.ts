import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListPartsRequest extends Omit<S3.ListPartsRequest, "Bucket"> {}

/**
 * Runtime binding for `s3:ListParts` (`s3:ListMultipartUploadParts`).
 *
 * Bind this operation to a bucket to get a callable that lists the parts
 * uploaded for an in-progress multipart upload — the bucket name is injected
 * automatically and `s3:ListMultipartUploadParts` is granted on the bucket's
 * objects. Provide the implementation with
 * `Effect.provide(AWS.S3.ListPartsHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example List Uploaded Parts
 * ```typescript
 * const listParts = yield* AWS.S3.ListParts(bucket);
 *
 * const result = yield* listParts({ Key: "large.bin", UploadId: uploadId });
 * const parts = result.Parts ?? [];
 * ```
 */
export interface ListParts extends Binding.Service<
  ListParts,
  "AWS.S3.ListParts",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: ListPartsRequest,
    ) => Effect.Effect<S3.ListPartsOutput, S3.ListPartsError>
  >
> {}
export const ListParts = Binding.Service<ListParts>("AWS.S3.ListParts");
