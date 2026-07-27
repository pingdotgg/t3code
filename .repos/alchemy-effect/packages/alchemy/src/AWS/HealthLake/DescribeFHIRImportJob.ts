import type * as healthlake from "@distilled.cloud/aws/healthlake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * `DescribeFHIRImportJob` request with `DatastoreId` injected from the bound
 * data store.
 */
export interface DescribeFHIRImportJobRequest extends Omit<
  healthlake.DescribeFHIRImportJobRequest,
  "DatastoreId"
> {}

/**
 * Runtime binding for the `DescribeFHIRImportJob` operation (IAM action
 * `healthlake:DescribeFHIRImportJob`), scoped to one {@link FHIRDatastore}.
 *
 * Reads the properties and progress report of a bulk FHIR import job started
 * with {@link StartFHIRImportJob} — poll `ImportJobProperties.JobStatus`
 * until `COMPLETED` (or a failure status). Provide the implementation with
 * `Effect.provide(AWS.HealthLake.DescribeFHIRImportJobHttp)`.
 *
 * @binding
 * @section Importing FHIR Data
 * @example Poll an Import Job Until It Completes
 * ```typescript
 * const describeImport = yield* HealthLake.DescribeFHIRImportJob(datastore);
 *
 * const job = yield* describeImport({ JobId: jobId }).pipe(
 *   Effect.map((r) => r.ImportJobProperties),
 *   Effect.repeat({
 *     schedule: Schedule.spaced("10 seconds"),
 *     until: (j) => j.JobStatus !== "SUBMITTED" && j.JobStatus !== "IN_PROGRESS",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface DescribeFHIRImportJob extends Binding.Service<
  DescribeFHIRImportJob,
  "AWS.HealthLake.DescribeFHIRImportJob",
  (
    datastore: FHIRDatastore,
  ) => Effect.Effect<
    (
      request: DescribeFHIRImportJobRequest,
    ) => Effect.Effect<
      healthlake.DescribeFHIRImportJobResponse,
      healthlake.DescribeFHIRImportJobError
    >
  >
> {}
export const DescribeFHIRImportJob = Binding.Service<DescribeFHIRImportJob>(
  "AWS.HealthLake.DescribeFHIRImportJob",
);
