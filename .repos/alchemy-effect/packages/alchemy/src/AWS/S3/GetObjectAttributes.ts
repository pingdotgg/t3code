import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectAttributesRequest extends Omit<
  S3.GetObjectAttributesRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:GetObjectAttributes`.
 *
 * Bind this operation to a bucket to get a callable that reads object
 * metadata (size, ETag, checksum, storage class, object parts) without
 * fetching the body — the bucket name is injected automatically and the
 * object-read attribute actions are granted on the bucket's objects. Provide
 * the implementation with `Effect.provide(AWS.S3.GetObjectAttributesHttp)`.
 * @binding
 * @section Reading Objects
 * @example Read Object Size and ETag
 * ```typescript
 * const getObjectAttributes = yield* AWS.S3.GetObjectAttributes(bucket);
 *
 * const attrs = yield* getObjectAttributes({
 *   Key: "reports/q3.csv",
 *   ObjectAttributes: ["ObjectSize", "ETag", "StorageClass"],
 * });
 * ```
 */
export interface GetObjectAttributes extends Binding.Service<
  GetObjectAttributes,
  "AWS.S3.GetObjectAttributes",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectAttributesRequest,
    ) => Effect.Effect<
      S3.GetObjectAttributesOutput,
      S3.GetObjectAttributesError
    >
  >
> {}
export const GetObjectAttributes = Binding.Service<GetObjectAttributes>(
  "AWS.S3.GetObjectAttributes",
);
