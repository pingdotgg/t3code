import type * as healthlake from "@distilled.cloud/aws/healthlake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * `StartFHIRExportJob` request with `DatastoreId` injected from the bound
 * data store and `DataAccessRoleArn` defaulting to the bound role.
 */
export interface StartFHIRExportJobRequest extends Omit<
  healthlake.StartFHIRExportJobRequest,
  "DatastoreId" | "DataAccessRoleArn"
> {
  /**
   * IAM role AWS HealthLake assumes to write the exported FHIR NDJSON to
   * the output S3 location.
   * @default the data-access role bound via `StartFHIRExportJob(datastore, role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for the `StartFHIRExportJob` operation (IAM action
 * `healthlake:StartFHIRExportJob`), scoped to one {@link FHIRDatastore}.
 *
 * Starts a bulk export of the bound data store's FHIR R4 resources to S3 as
 * NDJSON. The binding is constructed with the data store and the
 * **data-access role** (the IAM role HealthLake assumes to write
 * `OutputDataConfig.S3Configuration.S3Uri`, encrypted with its `KmsKeyId`;
 * the role's trust policy must allow `healthlake.amazonaws.com`). The role's
 * ARN is injected as `DataAccessRoleArn` on every runtime request and the
 * host is granted `iam:PassRole` on it alongside
 * `healthlake:StartFHIRExportJob` on the data store. Track the job with
 * {@link DescribeFHIRExportJob}. Provide the implementation with
 * `Effect.provide(AWS.HealthLake.StartFHIRExportJobHttp)`.
 *
 * @binding
 * @section Exporting FHIR Data
 * @example Start a Bulk FHIR Export Job
 * ```typescript
 * // deploy time — bind the data store and the HealthLake data-access role
 * const startExport = yield* HealthLake.StartFHIRExportJob(datastore, dataAccessRole);
 *
 * // runtime
 * const job = yield* startExport({
 *   OutputDataConfig: {
 *     S3Configuration: {
 *       S3Uri: "s3://my-bucket/fhir-export/",
 *       KmsKeyId: kmsKeyArn,
 *     },
 *   },
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartFHIRExportJob extends Binding.Service<
  StartFHIRExportJob,
  "AWS.HealthLake.StartFHIRExportJob",
  (
    datastore: FHIRDatastore,
    dataAccessRole: Role,
  ) => Effect.Effect<
    (
      request: StartFHIRExportJobRequest,
    ) => Effect.Effect<
      healthlake.StartFHIRExportJobResponse,
      healthlake.StartFHIRExportJobError
    >
  >
> {}
export const StartFHIRExportJob = Binding.Service<StartFHIRExportJob>(
  "AWS.HealthLake.StartFHIRExportJob",
);
