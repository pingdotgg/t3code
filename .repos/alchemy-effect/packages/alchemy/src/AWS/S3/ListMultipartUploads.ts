import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListMultipartUploadsRequest extends Omit<
  S3.ListMultipartUploadsRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:ListMultipartUploads` (`s3:ListBucketMultipartUploads`).
 *
 * Bind this operation to a bucket to get a callable that lists in-progress
 * multipart uploads — the bucket name is injected automatically and
 * `s3:ListBucketMultipartUploads` is granted on the bucket. Provide the
 * implementation with `Effect.provide(AWS.S3.ListMultipartUploadsHttp)`.
 * @binding
 * @section Multipart Uploads
 * @example List In-Progress Uploads
 * ```typescript
 * const listMultipartUploads = yield* AWS.S3.ListMultipartUploads(bucket);
 *
 * const result = yield* listMultipartUploads({ Prefix: "uploads/" });
 * const uploads = result.Uploads ?? [];
 * ```
 */
export interface ListMultipartUploads extends Binding.Service<
  ListMultipartUploads,
  "AWS.S3.ListMultipartUploads",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: ListMultipartUploadsRequest,
    ) => Effect.Effect<
      S3.ListMultipartUploadsOutput,
      S3.ListMultipartUploadsError
    >
  >
> {}
export const ListMultipartUploads = Binding.Service<ListMultipartUploads>(
  "AWS.S3.ListMultipartUploads",
);
