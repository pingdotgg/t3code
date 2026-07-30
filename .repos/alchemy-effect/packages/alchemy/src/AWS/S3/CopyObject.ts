// @ts-nocheck
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CopyObjectRequest extends Omit<
  S3.CopyObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:CopyObject`.
 *
 * Bind this operation to the destination bucket to get a callable that copies
 * objects server-side — no download/re-upload round trip. `CopySource` names
 * the source as `"source-bucket/key"`. Provide the implementation with
 * `Effect.provide(AWS.S3.CopyObjectHttp)`.
 * @binding
 * @section Copying Objects
 * @example Copy an Object Within a Bucket
 * ```typescript
 * // init — bind the operation to the destination bucket
 * const copyObject = yield* AWS.S3.CopyObject(bucket);
 *
 * // runtime — promote a staged upload to its final key
 * yield* copyObject({
 *   CopySource: `${bucketName}/incoming/report.pdf`,
 *   Key: "published/report.pdf",
 * });
 * ```
 */
export interface CopyObject extends Binding.Service<
  CopyObject,
  "AWS.S3.CopyObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CopyObjectRequest,
    ) => Effect.Effect<S3.CopyObjectOutput, S3.CopyObjectError>
  >
> {}

export const CopyObject = Binding.Service<CopyObject>("AWS.S3.CopyObject");
