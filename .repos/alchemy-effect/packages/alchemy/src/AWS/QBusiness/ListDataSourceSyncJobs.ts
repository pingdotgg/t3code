import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * `ListDataSourceSyncJobs` request with `applicationId` + `indexId` + `dataSourceId` injected from the bound data source.
 */
export interface ListDataSourceSyncJobsRequest extends Omit<
  qbusiness.ListDataSourceSyncJobsRequest,
  "applicationId" | "indexId" | "dataSourceId"
> {}

/**
 * Runtime binding for the `ListDataSourceSyncJobs` operation (IAM action
 * `qbusiness:ListDataSourceSyncJobs`), scoped to one {@link DataSource}.
 *
 * Lists the data source's synchronization job history.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListDataSourceSyncJobsHttp)`.
 *
 * @binding
 * @section Data Source Sync
 * @example List Sync Job History
 * ```typescript
 * const listSyncJobs = yield* AWS.QBusiness.ListDataSourceSyncJobs(source);
 *
 * const { history } = yield* listSyncJobs();
 * ```
 */
export interface ListDataSourceSyncJobs extends Binding.Service<
  ListDataSourceSyncJobs,
  "AWS.QBusiness.ListDataSourceSyncJobs",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    (
      request?: ListDataSourceSyncJobsRequest,
    ) => Effect.Effect<
      qbusiness.ListDataSourceSyncJobsResponse,
      qbusiness.ListDataSourceSyncJobsError
    >
  >
> {}
export const ListDataSourceSyncJobs = Binding.Service<ListDataSourceSyncJobs>(
  "AWS.QBusiness.ListDataSourceSyncJobs",
);
