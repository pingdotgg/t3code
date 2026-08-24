import type * as healthlake from "@distilled.cloud/aws/healthlake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * `StartFHIRImportJob` request with `DatastoreId` injected from the bound
 * data store and `DataAccessRoleArn` defaulting to the bound role.
 */
export interface StartFHIRImportJobRequest extends Omit<
  healthlake.StartFHIRImportJobRequest,
  "DatastoreId" | "DataAccessRoleArn"
> {
  /**
   * IAM role AWS HealthLake assumes to read the input FHIR NDJSON from S3
   * and write processing results.
   * @default the data-access role bound via `StartFHIRImportJob(datastore, role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for the `StartFHIRImportJob` operation (IAM action
 * `healthlake:StartFHIRImportJob`), scoped to one {@link FHIRDatastore}.
 *
 * Starts a bulk import of FHIR R4 NDJSON from S3 into the bound data store.
 * The binding is constructed with the data store and the **data-access
 * role** (the IAM role HealthLake assumes to read `InputDataConfig.S3Uri`
 * and write `JobOutputDataConfig`; its trust policy must allow
 * `healthlake.amazonaws.com`). The role's ARN is injected as
 * `DataAccessRoleArn` on every runtime request and the host is granted
 * `iam:PassRole` on it alongside `healthlake:StartFHIRImportJob` on the data
 * store. Track the job with {@link DescribeFHIRImportJob}. Provide the
 * implementation with `Effect.provide(AWS.HealthLake.StartFHIRImportJobHttp)`.
 *
 * @binding
 * @section Importing FHIR Data
 * @example Start a Bulk FHIR Import Job
 * ```typescript
 * // deploy time — bind the data store and the HealthLake data-access role
 * const startImport = yield* HealthLake.StartFHIRImportJob(datastore, dataAccessRole);
 *
 * // runtime
 * const job = yield* startImport({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/fhir-input/" },
 *   JobOutputDataConfig: {
 *     S3Configuration: {
 *       S3Uri: "s3://my-bucket/fhir-output/",
 *       KmsKeyId: kmsKeyArn,
 *     },
 *   },
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartFHIRImportJob extends Binding.Service<
  StartFHIRImportJob,
  "AWS.HealthLake.StartFHIRImportJob",
  (
    datastore: FHIRDatastore,
    dataAccessRole: Role,
  ) => Effect.Effect<
    (
      request: StartFHIRImportJobRequest,
    ) => Effect.Effect<
      healthlake.StartFHIRImportJobResponse,
      healthlake.StartFHIRImportJobError
    >
  >
> {}
export const StartFHIRImportJob = Binding.Service<StartFHIRImportJob>(
  "AWS.HealthLake.StartFHIRImportJob",
);
