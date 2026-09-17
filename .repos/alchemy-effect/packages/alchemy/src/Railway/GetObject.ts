import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { RailwayS3CredentialsMissing } from "./BucketBinding.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

/**
 * Runtime binding for Railway `GetObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. Provide
 * {@link GetObjectHttp}.
 *
 *
 * ### Reading Objects
 * **Example:** Read an Object and Decode Its Body
 * ```typescript
 * const getObject = yield* Railway.GetObject(Data);
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
  "Railway.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: GetObjectRequest,
    ) => Effect.Effect<
      S3.GetObjectOutput,
      S3.GetObjectError | Config.ConfigError | RailwayS3CredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const GetObject = Binding.Service<GetObject>("Railway.GetObject");
