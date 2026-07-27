import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `CopyImageSet` request with `datastoreId` injected from the bound data
 * store.
 */
export interface CopyImageSetRequest extends Omit<
  medicalimaging.CopyImageSetRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `CopyImageSet` operation (IAM action
 * `medical-imaging:CopyImageSet`), scoped to one {@link Datastore}.
 *
 * Copies an image set into a new one (omit `destinationImageSet`) or merges
 * it into an existing destination image set within the same data store.
 * Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.CopyImageSetHttp)`.
 *
 * @binding
 * @section Updating Image Sets
 * @example Copy an Image Set
 * ```typescript
 * const copyImageSet = yield* MedicalImaging.CopyImageSet(datastore);
 *
 * const copy = yield* copyImageSet({
 *   sourceImageSetId,
 *   copyImageSetInformation: {
 *     sourceImageSet: { latestVersionId: "1" },
 *   },
 * });
 * // copy.destinationImageSetProperties.imageSetId
 * ```
 */
export interface CopyImageSet extends Binding.Service<
  CopyImageSet,
  "AWS.MedicalImaging.CopyImageSet",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: CopyImageSetRequest,
    ) => Effect.Effect<
      medicalimaging.CopyImageSetResponse,
      medicalimaging.CopyImageSetError
    >
  >
> {}
export const CopyImageSet = Binding.Service<CopyImageSet>(
  "AWS.MedicalImaging.CopyImageSet",
);
