import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `SearchImageSets` request with `datastoreId` injected from the bound data
 * store.
 */
export interface SearchImageSetsRequest extends Omit<
  medicalimaging.SearchImageSetsRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `SearchImageSets` operation (IAM action
 * `medical-imaging:SearchImageSets`), scoped to one {@link Datastore}.
 *
 * Searches the data store's image sets by DICOM attributes (patient id,
 * accession number, study/series instance UID, study date/time) or by
 * created/updated timestamps. Omit `searchCriteria` to page through every
 * image set. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.SearchImageSetsHttp)`.
 *
 * @binding
 * @section Searching Image Sets
 * @example Search by Patient Id
 * ```typescript
 * const searchImageSets = yield* MedicalImaging.SearchImageSets(datastore);
 *
 * const results = yield* searchImageSets({
 *   searchCriteria: {
 *     filters: [{ operator: "EQUAL", values: [{ DICOMPatientId: patientId }] }],
 *   },
 * });
 * // results.imageSetsMetadataSummaries[i].imageSetId
 * ```
 *
 * @example List Every Image Set
 * ```typescript
 * const results = yield* searchImageSets();
 * ```
 */
export interface SearchImageSets extends Binding.Service<
  SearchImageSets,
  "AWS.MedicalImaging.SearchImageSets",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request?: SearchImageSetsRequest,
    ) => Effect.Effect<
      medicalimaging.SearchImageSetsResponse,
      medicalimaging.SearchImageSetsError
    >
  >
> {}
export const SearchImageSets = Binding.Service<SearchImageSets>(
  "AWS.MedicalImaging.SearchImageSets",
);
