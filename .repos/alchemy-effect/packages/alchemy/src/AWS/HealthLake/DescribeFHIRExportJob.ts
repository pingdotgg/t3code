import type * as healthlake from "@distilled.cloud/aws/healthlake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * `DescribeFHIRExportJob` request with `DatastoreId` injected from the bound
 * data store.
 */
export interface DescribeFHIRExportJobRequest extends Omit<
  healthlake.DescribeFHIRExportJobRequest,
  "DatastoreId"
> {}

/**
 * Runtime binding for the `DescribeFHIRExportJob` operation (IAM action
 * `healthlake:DescribeFHIRExportJob`), scoped to one {@link FHIRDatastore}.
 *
 * Reads the properties of a bulk FHIR export job started with
 * {@link StartFHIRExportJob} — poll `ExportJobProperties.JobStatus` until
 * `COMPLETED` (or a failure status). Provide the implementation with
 * `Effect.provide(AWS.HealthLake.DescribeFHIRExportJobHttp)`.
 *
 * @binding
 * @section Exporting FHIR Data
 * @example Poll an Export Job Until It Completes
 * ```typescript
 * const describeExport = yield* HealthLake.DescribeFHIRExportJob(datastore);
 *
 * const job = yield* describeExport({ JobId: jobId }).pipe(
 *   Effect.map((r) => r.ExportJobProperties),
 *   Effect.repeat({
 *     schedule: Schedule.spaced("10 seconds"),
 *     until: (j) => j.JobStatus !== "SUBMITTED" && j.JobStatus !== "IN_PROGRESS",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface DescribeFHIRExportJob extends Binding.Service<
  DescribeFHIRExportJob,
  "AWS.HealthLake.DescribeFHIRExportJob",
  (
    datastore: FHIRDatastore,
  ) => Effect.Effect<
    (
      request: DescribeFHIRExportJobRequest,
    ) => Effect.Effect<
      healthlake.DescribeFHIRExportJobResponse,
      healthlake.DescribeFHIRExportJobError
    >
  >
> {}
export const DescribeFHIRExportJob = Binding.Service<DescribeFHIRExportJob>(
  "AWS.HealthLake.DescribeFHIRExportJob",
);
