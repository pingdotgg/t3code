import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * Runtime binding for the `StopDataSourceSyncJob` operation (IAM action
 * `kendra:StopDataSourceSyncJob`), scoped to one {@link DataSource}.
 *
 * Stops the data source's currently-running sync job, if any.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.StopDataSourceSyncJobHttp)`.
 *
 * @binding
 * @section Syncing Data Sources
 * @example Stop a Running Sync
 * ```typescript
 * const stopSync = yield* AWS.Kendra.StopDataSourceSyncJob(source);
 *
 * yield* stopSync();
 * ```
 */
export interface StopDataSourceSyncJob extends Binding.Service<
  StopDataSourceSyncJob,
  "AWS.Kendra.StopDataSourceSyncJob",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    () => Effect.Effect<
      kendra.StopDataSourceSyncJobResponse,
      kendra.StopDataSourceSyncJobError
    >
  >
> {}
export const StopDataSourceSyncJob = Binding.Service<StopDataSourceSyncJob>(
  "AWS.Kendra.StopDataSourceSyncJob",
);
