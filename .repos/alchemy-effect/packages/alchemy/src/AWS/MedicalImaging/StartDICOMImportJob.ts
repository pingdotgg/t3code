import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `StartDICOMImportJob` request with `datastoreId` injected from the bound
 * data store and `dataAccessRoleArn` defaulting to the bound role.
 */
export interface StartDICOMImportJobRequest extends Omit<
  medicalimaging.StartDICOMImportJobRequest,
  "datastoreId" | "dataAccessRoleArn"
> {
  /**
   * IAM role AWS HealthImaging assumes to read the DICOM P10 input from S3
   * and write the import manifests.
   * @default the data-access role bound via `StartDICOMImportJob(datastore, role)`
   */
  dataAccessRoleArn?: string;
}

/**
 * Runtime binding for the `StartDICOMImportJob` operation (IAM action
 * `medical-imaging:StartDICOMImportJob`), scoped to one {@link Datastore}.
 *
 * Starts a bulk import of DICOM P10 files from S3 into the bound data
 * store. The binding is constructed with the data store and the
 * **data-access role** (the IAM role HealthImaging assumes to read
 * `inputS3Uri` and write the `outputS3Uri` manifests; its trust policy must
 * allow `medical-imaging.amazonaws.com`). The role's ARN is injected as
 * `dataAccessRoleArn` on every runtime request and the host is granted
 * `iam:PassRole` on it alongside `medical-imaging:StartDICOMImportJob` on
 * the data store. Track the job with {@link GetDICOMImportJob}. Provide the
 * implementation with
 * `Effect.provide(AWS.MedicalImaging.StartDICOMImportJobHttp)`.
 *
 * @binding
 * @section Importing DICOM Data
 * @example Start a Bulk DICOM Import Job
 * ```typescript
 * // deploy time — bind the data store and the HealthImaging data-access role
 * const startImport = yield* MedicalImaging.StartDICOMImportJob(datastore, dataAccessRole);
 *
 * // runtime
 * const job = yield* startImport({
 *   clientToken: crypto.randomUUID(),
 *   inputS3Uri: "s3://my-bucket/dicom-input/",
 *   outputS3Uri: "s3://my-bucket/dicom-output/",
 * });
 * // job.jobId, job.jobStatus === "SUBMITTED"
 * ```
 */
export interface StartDICOMImportJob extends Binding.Service<
  StartDICOMImportJob,
  "AWS.MedicalImaging.StartDICOMImportJob",
  (
    datastore: Datastore,
    dataAccessRole: Role,
  ) => Effect.Effect<
    (
      request: StartDICOMImportJobRequest,
    ) => Effect.Effect<
      medicalimaging.StartDICOMImportJobResponse,
      medicalimaging.StartDICOMImportJobError
    >
  >
> {}
export const StartDICOMImportJob = Binding.Service<StartDICOMImportJob>(
  "AWS.MedicalImaging.StartDICOMImportJob",
);
