import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `DeleteImageSet` request with `datastoreId` injected from the bound data
 * store.
 */
export interface DeleteImageSetRequest extends Omit<
  medicalimaging.DeleteImageSetRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `DeleteImageSet` operation (IAM action
 * `medical-imaging:DeleteImageSet`), scoped to one {@link Datastore}.
 *
 * Deletes an image set (asynchronously — the response reports
 * `imageSetWorkflowStatus: "DELETING"`). A data store must contain no image
 * sets before it can be deleted. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.DeleteImageSetHttp)`.
 *
 * @binding
 * @section Updating Image Sets
 * @example Delete an Image Set
 * ```typescript
 * const deleteImageSet = yield* MedicalImaging.DeleteImageSet(datastore);
 *
 * const deleted = yield* deleteImageSet({ imageSetId });
 * // deleted.imageSetWorkflowStatus === "DELETING"
 * ```
 */
export interface DeleteImageSet extends Binding.Service<
  DeleteImageSet,
  "AWS.MedicalImaging.DeleteImageSet",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: DeleteImageSetRequest,
    ) => Effect.Effect<
      medicalimaging.DeleteImageSetResponse,
      medicalimaging.DeleteImageSetError
    >
  >
> {}
export const DeleteImageSet = Binding.Service<DeleteImageSet>(
  "AWS.MedicalImaging.DeleteImageSet",
);
