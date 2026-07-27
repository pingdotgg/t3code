import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `ListImageSetVersions` request with `datastoreId` injected from the bound
 * data store.
 */
export interface ListImageSetVersionsRequest extends Omit<
  medicalimaging.ListImageSetVersionsRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `ListImageSetVersions` operation (IAM action
 * `medical-imaging:ListImageSetVersions`), scoped to one {@link Datastore}.
 *
 * Lists every version of an image set — each {@link UpdateImageSetMetadata}
 * call produces a new version, and older versions remain readable and
 * revertible. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.ListImageSetVersionsHttp)`.
 *
 * @binding
 * @section Reading Image Sets
 * @example List an Image Set's Versions
 * ```typescript
 * const listVersions = yield* MedicalImaging.ListImageSetVersions(datastore);
 *
 * const versions = yield* listVersions({ imageSetId });
 * // versions.imageSetPropertiesList[i].versionId
 * ```
 */
export interface ListImageSetVersions extends Binding.Service<
  ListImageSetVersions,
  "AWS.MedicalImaging.ListImageSetVersions",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: ListImageSetVersionsRequest,
    ) => Effect.Effect<
      medicalimaging.ListImageSetVersionsResponse,
      medicalimaging.ListImageSetVersionsError
    >
  >
> {}
export const ListImageSetVersions = Binding.Service<ListImageSetVersions>(
  "AWS.MedicalImaging.ListImageSetVersions",
);
