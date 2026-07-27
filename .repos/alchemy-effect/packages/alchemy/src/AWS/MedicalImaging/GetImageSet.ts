import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `GetImageSet` request with `datastoreId` injected from the bound data
 * store.
 */
export interface GetImageSetRequest extends Omit<
  medicalimaging.GetImageSetRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `GetImageSet` operation (IAM action
 * `medical-imaging:GetImageSet`), scoped to one {@link Datastore}.
 *
 * Reads an image set's properties — state, workflow status, version and
 * ARN. Pass `versionId` to read a specific version; omit it for the latest.
 * Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.GetImageSetHttp)`.
 *
 * @binding
 * @section Reading Image Sets
 * @example Read Image Set Properties
 * ```typescript
 * const getImageSet = yield* MedicalImaging.GetImageSet(datastore);
 *
 * const imageSet = yield* getImageSet({ imageSetId });
 * // imageSet.imageSetState === "ACTIVE", imageSet.versionId, imageSet.imageSetArn
 * ```
 */
export interface GetImageSet extends Binding.Service<
  GetImageSet,
  "AWS.MedicalImaging.GetImageSet",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: GetImageSetRequest,
    ) => Effect.Effect<
      medicalimaging.GetImageSetResponse,
      medicalimaging.GetImageSetError
    >
  >
> {}
export const GetImageSet = Binding.Service<GetImageSet>(
  "AWS.MedicalImaging.GetImageSet",
);
