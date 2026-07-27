import type * as healthlake from "@distilled.cloud/aws/healthlake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * `ListFHIRImportJobs` request with `DatastoreId` injected from the bound
 * data store.
 */
export interface ListFHIRImportJobsRequest extends Omit<
  healthlake.ListFHIRImportJobsRequest,
  "DatastoreId"
> {}

/**
 * Runtime binding for the `ListFHIRImportJobs` operation (IAM action
 * `healthlake:ListFHIRImportJobs`), scoped to one {@link FHIRDatastore}.
 *
 * Lists the bulk FHIR import jobs of the bound data store, optionally
 * filtered by name, status or submit-time window. Provide the implementation
 * with `Effect.provide(AWS.HealthLake.ListFHIRImportJobsHttp)`.
 *
 * @binding
 * @section Importing FHIR Data
 * @example List Recent Import Jobs
 * ```typescript
 * const listImports = yield* HealthLake.ListFHIRImportJobs(datastore);
 *
 * const jobs = yield* listImports({ JobStatus: "COMPLETED" });
 * // jobs.ImportJobPropertiesList, jobs.NextToken
 * ```
 */
export interface ListFHIRImportJobs extends Binding.Service<
  ListFHIRImportJobs,
  "AWS.HealthLake.ListFHIRImportJobs",
  (
    datastore: FHIRDatastore,
  ) => Effect.Effect<
    (
      request?: ListFHIRImportJobsRequest,
    ) => Effect.Effect<
      healthlake.ListFHIRImportJobsResponse,
      healthlake.ListFHIRImportJobsError
    >
  >
> {}
export const ListFHIRImportJobs = Binding.Service<ListFHIRImportJobs>(
  "AWS.HealthLake.ListFHIRImportJobs",
);
