import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `ListDICOMImportJobs` request with `datastoreId` injected from the bound
 * data store.
 */
export interface ListDICOMImportJobsRequest extends Omit<
  medicalimaging.ListDICOMImportJobsRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `ListDICOMImportJobs` operation (IAM action
 * `medical-imaging:ListDICOMImportJobs`), scoped to one {@link Datastore}.
 *
 * Lists the data store's DICOM import jobs, optionally filtered by
 * `jobStatus`. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.ListDICOMImportJobsHttp)`.
 *
 * @binding
 * @section Importing DICOM Data
 * @example List In-Progress Import Jobs
 * ```typescript
 * const listImportJobs = yield* MedicalImaging.ListDICOMImportJobs(datastore);
 *
 * const jobs = yield* listImportJobs({ jobStatus: "IN_PROGRESS" });
 * // jobs.jobSummaries[i].jobId
 * ```
 */
export interface ListDICOMImportJobs extends Binding.Service<
  ListDICOMImportJobs,
  "AWS.MedicalImaging.ListDICOMImportJobs",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request?: ListDICOMImportJobsRequest,
    ) => Effect.Effect<
      medicalimaging.ListDICOMImportJobsResponse,
      medicalimaging.ListDICOMImportJobsError
    >
  >
> {}
export const ListDICOMImportJobs = Binding.Service<ListDICOMImportJobs>(
  "AWS.MedicalImaging.ListDICOMImportJobs",
);
