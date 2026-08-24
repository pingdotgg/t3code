import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `UpdateImageSetMetadata` request with `datastoreId` injected from the
 * bound data store.
 */
export interface UpdateImageSetMetadataRequest extends Omit<
  medicalimaging.UpdateImageSetMetadataRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `UpdateImageSetMetadata` operation (IAM action
 * `medical-imaging:UpdateImageSetMetadata`), scoped to one
 * {@link Datastore}.
 *
 * Adds, updates, or removes DICOM attributes on an image set (each update
 * produces a new version), or reverts the image set to a previous version
 * via `revertToVersionId`. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.UpdateImageSetMetadataHttp)`.
 *
 * @binding
 * @section Updating Image Sets
 * @example Revert an Image Set to a Previous Version
 * ```typescript
 * const updateMetadata = yield* MedicalImaging.UpdateImageSetMetadata(datastore);
 *
 * const updated = yield* updateMetadata({
 *   imageSetId,
 *   latestVersionId,
 *   updateImageSetMetadataUpdates: { revertToVersionId: "1" },
 * });
 * // updated.latestVersionId
 * ```
 */
export interface UpdateImageSetMetadata extends Binding.Service<
  UpdateImageSetMetadata,
  "AWS.MedicalImaging.UpdateImageSetMetadata",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: UpdateImageSetMetadataRequest,
    ) => Effect.Effect<
      medicalimaging.UpdateImageSetMetadataResponse,
      medicalimaging.UpdateImageSetMetadataError
    >
  >
> {}
export const UpdateImageSetMetadata = Binding.Service<UpdateImageSetMetadata>(
  "AWS.MedicalImaging.UpdateImageSetMetadata",
);
