import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { TigrisCredentialsMissing } from "./Errors.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

/**
 * Runtime binding for Tigris `GetObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. Provide
 * {@link GetObjectHttp}.
 *
 *
 * ### Reading Objects
 * **Example:** Read an Object and Decode Its Body
 * ```typescript
 * const getObject = yield* Fly.GetObject(Data);
 *
 * const text = yield* getObject({ Key: "hello.txt" }).pipe(
 *   Effect.flatMap((result) =>
 *     Stream.mkString(Stream.decodeText(result.Body!)),
 *   ),
 * );
 * ```
 *
 * @binding
 */
export interface GetObject extends Binding.Service<
  GetObject,
  "Fly.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<
      S3.GetObjectOutput,
      S3.GetObjectError | TigrisCredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const GetObject = Binding.Service<GetObject>("Fly.GetObject");
