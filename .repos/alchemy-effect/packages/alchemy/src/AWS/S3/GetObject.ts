import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

/**
 * Runtime binding for `s3:GetObject`.
 *
 * Bind this operation to a bucket in the function's init phase to get a
 * callable that reads objects — the bucket name is injected automatically and
 * `s3:GetObject` is granted on the bucket. Provide the implementation with
 * `Effect.provide(AWS.S3.GetObjectHttp)`.
 * @binding
 * @section Reading Objects
 * @example Read an Object and Decode Its Body
 * ```typescript
 * // init — bind the operation to the bucket
 * const getObject = yield* AWS.S3.GetObject(bucket);
 *
 * // runtime — the Body is a Stream; decode it to a string
 * const text = yield* getObject({ Key: "jobs/job-123.json" }).pipe(
 *   Effect.flatMap((result) =>
 *     Stream.mkString(Stream.decodeText(result.Body!)),
 *   ),
 * );
 * ```
 *
 * @example Treat a Missing Key as Absence
 * ```typescript
 * const job = yield* getObject({ Key: `jobs/${jobId}.json` }).pipe(
 *   Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
 * );
 * ```
 */
export interface GetObject extends Binding.Service<
  GetObject,
  "AWS.S3.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<S3.GetObjectOutput, S3.GetObjectError>
  >
> {}

export const GetObject = Binding.Service<GetObject>("AWS.S3.GetObject");
