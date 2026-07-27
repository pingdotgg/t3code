import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `GetDICOMImportJob` request with `datastoreId` injected from the bound
 * data store.
 */
export interface GetDICOMImportJobRequest extends Omit<
  medicalimaging.GetDICOMImportJobRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `GetDICOMImportJob` operation (IAM action
 * `medical-imaging:GetDICOMImportJob`), scoped to one {@link Datastore}.
 *
 * Reads the properties of a DICOM import job started with
 * {@link StartDICOMImportJob} — poll `jobProperties.jobStatus` until
 * `COMPLETED` (or `FAILED`), then review the output manifests at
 * `outputS3Uri` for per-object results. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.GetDICOMImportJobHttp)`.
 *
 * @binding
 * @section Importing DICOM Data
 * @example Poll an Import Job Until It Completes
 * ```typescript
 * const getImportJob = yield* MedicalImaging.GetDICOMImportJob(datastore);
 *
 * const job = yield* getImportJob({ jobId }).pipe(
 *   Effect.map((r) => r.jobProperties),
 *   Effect.repeat({
 *     schedule: Schedule.spaced("10 seconds"),
 *     until: (j) => j.jobStatus !== "SUBMITTED" && j.jobStatus !== "IN_PROGRESS",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface GetDICOMImportJob extends Binding.Service<
  GetDICOMImportJob,
  "AWS.MedicalImaging.GetDICOMImportJob",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: GetDICOMImportJobRequest,
    ) => Effect.Effect<
      medicalimaging.GetDICOMImportJobResponse,
      medicalimaging.GetDICOMImportJobError
    >
  >
> {}
export const GetDICOMImportJob = Binding.Service<GetDICOMImportJob>(
  "AWS.MedicalImaging.GetDICOMImportJob",
);
