import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * `ListDataSourceSyncJobs` request with `Id` and `IndexId` injected from the bound data source.
 */
export interface ListDataSourceSyncJobsRequest extends Omit<
  kendra.ListDataSourceSyncJobsRequest,
  "Id" | "IndexId"
> {}

/**
 * Runtime binding for the `ListDataSourceSyncJobs` operation (IAM action
 * `kendra:ListDataSourceSyncJobs`), scoped to one {@link DataSource}.
 *
 * Lists the data source's sync-job history — status, error details, and
 * per-run document add/modify/delete/fail metrics.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.ListDataSourceSyncJobsHttp)`.
 *
 * @binding
 * @section Syncing Data Sources
 * @example Sync Job History
 * ```typescript
 * const listSyncJobs = yield* AWS.Kendra.ListDataSourceSyncJobs(source);
 *
 * const jobs = yield* listSyncJobs({ StatusFilter: "SUCCEEDED" });
 * console.log(jobs.History?.[0]?.Metrics);
 * ```
 */
export interface ListDataSourceSyncJobs extends Binding.Service<
  ListDataSourceSyncJobs,
  "AWS.Kendra.ListDataSourceSyncJobs",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    (
      request?: ListDataSourceSyncJobsRequest,
    ) => Effect.Effect<
      kendra.ListDataSourceSyncJobsResponse,
      kendra.ListDataSourceSyncJobsError
    >
  >
> {}
export const ListDataSourceSyncJobs = Binding.Service<ListDataSourceSyncJobs>(
  "AWS.Kendra.ListDataSourceSyncJobs",
);
