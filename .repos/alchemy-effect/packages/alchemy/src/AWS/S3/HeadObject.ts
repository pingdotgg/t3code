import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface HeadObjectRequest extends Omit<
  S3.HeadObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:HeadObject`.
 *
 * Bind this operation to a bucket to get a callable that reads an object's
 * metadata (size, content type, ETag) without downloading the body. Provide
 * the implementation with `Effect.provide(AWS.S3.HeadObjectHttp)`.
 *
 * The HTTP implementation grants `s3:GetObject` for current-object reads and
 * `s3:GetObjectVersion` because this request also supports `VersionId`. It
 * additionally grants `s3:ListBucket` so a missing key produces AWS's
 * documented `404`/`403` distinction instead of always being reported as
 * `AccessDenied`. See the [HeadObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)
 * and [S3 required permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html).
 *
 * ### Inspecting Objects
 * **Example:** Check an Object's Metadata
 * ```typescript
 * // init — bind the operation to the bucket
 * const headObject = yield* AWS.S3.HeadObject(bucket);
 *
 * // runtime — inspect without transferring the body
 * const head = yield* headObject({ Key: "uploads/report.pdf" });
 * const size = head.ContentLength;
 * const contentType = head.ContentType;
 * ```
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html
 *
 * @binding
 */
export interface HeadObject extends Binding.Service<
  HeadObject,
  "AWS.S3.HeadObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: HeadObjectRequest,
    ) => Effect.Effect<S3.HeadObjectOutput, S3.HeadObjectError>
  >
> {}

export const HeadObject = Binding.Service<HeadObject>("AWS.S3.HeadObject");
