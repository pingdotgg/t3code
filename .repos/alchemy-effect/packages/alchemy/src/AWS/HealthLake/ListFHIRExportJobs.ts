import type * as healthlake from "@distilled.cloud/aws/healthlake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * `ListFHIRExportJobs` request with `DatastoreId` injected from the bound
 * data store.
 */
export interface ListFHIRExportJobsRequest extends Omit<
  healthlake.ListFHIRExportJobsRequest,
  "DatastoreId"
> {}

/**
 * Runtime binding for the `ListFHIRExportJobs` operation (IAM action
 * `healthlake:ListFHIRExportJobs`), scoped to one {@link FHIRDatastore}.
 *
 * Lists the bulk FHIR export jobs of the bound data store, optionally
 * filtered by name, status or submit-time window. Provide the implementation
 * with `Effect.provide(AWS.HealthLake.ListFHIRExportJobsHttp)`.
 *
 * @binding
 * @section Exporting FHIR Data
 * @example List Recent Export Jobs
 * ```typescript
 * const listExports = yield* HealthLake.ListFHIRExportJobs(datastore);
 *
 * const jobs = yield* listExports({ JobStatus: "IN_PROGRESS" });
 * // jobs.ExportJobPropertiesList, jobs.NextToken
 * ```
 */
export interface ListFHIRExportJobs extends Binding.Service<
  ListFHIRExportJobs,
  "AWS.HealthLake.ListFHIRExportJobs",
  (
    datastore: FHIRDatastore,
  ) => Effect.Effect<
    (
      request?: ListFHIRExportJobsRequest,
    ) => Effect.Effect<
      healthlake.ListFHIRExportJobsResponse,
      healthlake.ListFHIRExportJobsError
    >
  >
> {}
export const ListFHIRExportJobs = Binding.Service<ListFHIRExportJobs>(
  "AWS.HealthLake.ListFHIRExportJobs",
);
