import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

/**
 * Runtime binding for `s3:PutObject`.
 *
 * Bind this operation to a bucket to get a callable that writes objects without
 * manually supplying the bucket name on every request. `s3:PutObject` is
 * granted on the bucket automatically. Provide the implementation with
 * `Effect.provide(AWS.S3.PutObjectHttp)`.
 * @binding
 * @section Writing Objects
 * @example Put an Object
 * ```typescript
 * const putObject = yield* PutObject(bucket);
 *
 * yield* putObject({
 *   Key: "hello.txt",
 *   Body: "Hello, world!",
 *   ContentType: "text/plain",
 * });
 * ```
 */
export interface PutObject extends Binding.Service<
  PutObject,
  "AWS.S3.PutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<S3.PutObjectOutput, S3.PutObjectError>
  >
> {}
export const PutObject = Binding.Service<PutObject>("AWS.S3.PutObject");
