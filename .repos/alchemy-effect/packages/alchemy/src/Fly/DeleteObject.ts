import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { TigrisCredentialsMissing } from "./Errors.ts";

export interface DeleteObjectRequest extends Omit<
  S3.DeleteObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for Tigris `DeleteObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. Provide
 * {@link DeleteObjectHttp}.
 *
 *
 * ### Deleting Objects
 * **Example:** Delete an Object
 * ```typescript
 * const deleteObject = yield* Fly.DeleteObject(Data);
 * yield* deleteObject({ Key: "hello.txt" });
 * ```
 *
 * @binding
 */
export interface DeleteObject extends Binding.Service<
  DeleteObject,
  "Fly.DeleteObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectRequest,
    ) => Effect.Effect<
      S3.DeleteObjectOutput,
      S3.DeleteObjectError | TigrisCredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const DeleteObject = Binding.Service<DeleteObject>("Fly.DeleteObject");
