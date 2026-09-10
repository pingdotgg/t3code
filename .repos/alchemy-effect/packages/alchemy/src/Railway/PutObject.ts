import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { RailwayS3CredentialsMissing } from "./BucketBinding.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

/**
 * Runtime binding for Railway `PutObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. The bucket
 * name, endpoint, and credentials are injected automatically. Provide
 * {@link PutObjectHttp}.
 *
 *
 * ### Writing Objects
 * **Example:** Put an Object
 * ```typescript
 * const putObject = yield* Railway.PutObject(Data);
 *
 * yield* putObject({
 *   Key: "hello.txt",
 *   Body: "Hello, world!",
 *   ContentType: "text/plain",
 * });
 * ```
 *
 * @binding
 */
export interface PutObject extends Binding.Service<
  PutObject,
  "Railway.PutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: PutObjectRequest,
    ) => Effect.Effect<
      S3.PutObjectOutput,
      S3.PutObjectError | Config.ConfigError | RailwayS3CredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const PutObject = Binding.Service<PutObject>("Railway.PutObject");
