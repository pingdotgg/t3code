import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * `StartDataSourceSyncJob` request with `applicationId` + `indexId` + `dataSourceId` injected from the bound data source.
 */
export interface StartDataSourceSyncJobRequest extends Omit<
  qbusiness.StartDataSourceSyncJobRequest,
  "applicationId" | "indexId" | "dataSourceId"
> {}

/**
 * Runtime binding for the `StartDataSourceSyncJob` operation (IAM action
 * `qbusiness:StartDataSourceSyncJob`), scoped to one {@link DataSource}.
 *
 * Starts a synchronization job that crawls the connector and ingests
 * its content into the index.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.StartDataSourceSyncJobHttp)`.
 *
 * @binding
 * @section Data Source Sync
 * @example Start a Sync Job
 * ```typescript
 * const startSync = yield* AWS.QBusiness.StartDataSourceSyncJob(source);
 *
 * const { executionId } = yield* startSync();
 * ```
 */
export interface StartDataSourceSyncJob extends Binding.Service<
  StartDataSourceSyncJob,
  "AWS.QBusiness.StartDataSourceSyncJob",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    (
      request?: StartDataSourceSyncJobRequest,
    ) => Effect.Effect<
      qbusiness.StartDataSourceSyncJobResponse,
      qbusiness.StartDataSourceSyncJobError
    >
  >
> {}
export const StartDataSourceSyncJob = Binding.Service<StartDataSourceSyncJob>(
  "AWS.QBusiness.StartDataSourceSyncJob",
);
