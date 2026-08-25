import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * `StopDataSourceSyncJob` request with `applicationId` + `indexId` + `dataSourceId` injected from the bound data source.
 */
export interface StopDataSourceSyncJobRequest extends Omit<
  qbusiness.StopDataSourceSyncJobRequest,
  "applicationId" | "indexId" | "dataSourceId"
> {}

/**
 * Runtime binding for the `StopDataSourceSyncJob` operation (IAM action
 * `qbusiness:StopDataSourceSyncJob`), scoped to one {@link DataSource}.
 *
 * Stops the data source's running synchronization job.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.StopDataSourceSyncJobHttp)`.
 *
 * @binding
 * @section Data Source Sync
 * @example Stop the Running Sync Job
 * ```typescript
 * const stopSync = yield* AWS.QBusiness.StopDataSourceSyncJob(source);
 *
 * yield* stopSync();
 * ```
 */
export interface StopDataSourceSyncJob extends Binding.Service<
  StopDataSourceSyncJob,
  "AWS.QBusiness.StopDataSourceSyncJob",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    (
      request?: StopDataSourceSyncJobRequest,
    ) => Effect.Effect<
      qbusiness.StopDataSourceSyncJobResponse,
      qbusiness.StopDataSourceSyncJobError
    >
  >
> {}
export const StopDataSourceSyncJob = Binding.Service<StopDataSourceSyncJob>(
  "AWS.QBusiness.StopDataSourceSyncJob",
);
