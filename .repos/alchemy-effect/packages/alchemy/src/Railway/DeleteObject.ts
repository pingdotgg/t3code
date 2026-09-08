import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { RailwayS3CredentialsMissing } from "./BucketBinding.ts";

export interface DeleteObjectRequest extends Omit<
  S3.DeleteObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for Railway `DeleteObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. Provide
 * {@link DeleteObjectHttp}.
 *
 *
 * ### Deleting Objects
 * **Example:** Delete an Object
 * ```typescript
 * const deleteObject = yield* Railway.DeleteObject(Data);
 * yield* deleteObject({ Key: "hello.txt" });
 * ```
 *
 * @binding
 */
export interface DeleteObject extends Binding.Service<
  DeleteObject,
  "Railway.DeleteObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: DeleteObjectRequest,
    ) => Effect.Effect<
      S3.DeleteObjectOutput,
      S3.DeleteObjectError | Config.ConfigError | RailwayS3CredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const DeleteObject = Binding.Service<DeleteObject>(
  "Railway.DeleteObject",
);
