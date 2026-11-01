import type * as storage from "@distilled.cloud/gcp/storage_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectRequest extends Omit<
  storage.DeleteObjectsRequest,
  "bucket"
> {}

/**
 * Runtime binding for Cloud Storage `objects.delete`.
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link DeleteObjectHttp}.
 *
 * ### Deleting Objects
 * **Example:** Delete an object
 * ```typescript
 * const deleteObject = yield* GCP.Storage.DeleteObject(bucket);
 * yield* deleteObject({ object: "hello.txt" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteObject extends Binding.Service<
  DeleteObject,
  "GCP.Storage.DeleteObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectRequest,
    ) => Effect.Effect<
      storage.DeleteObjectsResponse,
      storage.DeleteObjectsError,
      RuntimeContext
    >
  >
> {}

export const DeleteObject = Binding.Service<DeleteObject>(
  "GCP.Storage.DeleteObject",
);
