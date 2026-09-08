import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { TigrisCredentialsMissing } from "./Errors.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

/**
 * Runtime binding for Tigris `PutObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. The Tigris
 * bucket name, endpoint, and credentials are injected automatically.
 * Provide {@link PutObjectHttp}.
 *
 *
 * ### Writing Objects
 * **Example:** Put an Object
 * ```typescript
 * const putObject = yield* Fly.PutObject(Data);
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
  "Fly.PutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<
      S3.PutObjectOutput,
      S3.PutObjectError | TigrisCredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const PutObject = Binding.Service<PutObject>("Fly.PutObject");
