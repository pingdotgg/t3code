import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * Runtime binding for the `StartDataSourceSyncJob` operation (IAM action
 * `kendra:StartDataSourceSyncJob`), scoped to one {@link DataSource}.
 *
 * Starts an on-demand sync of the data source into its index — the
 * programmatic alternative to the data source's cron `schedule`. Fails
 * with `ResourceInUseException` while another sync is already running.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.StartDataSourceSyncJobHttp)`.
 *
 * ### Syncing Data Sources
 * **Example:** Trigger a Sync
 * ```typescript
 * const startSync = yield* AWS.Kendra.StartDataSourceSyncJob(source);
 *
 * const { ExecutionId } = yield* startSync();
 * ```
 *
 * @binding
 */
export interface StartDataSourceSyncJob extends Binding.Service<
  StartDataSourceSyncJob,
  "AWS.Kendra.StartDataSourceSyncJob",
  (
    dataSource: DataSource,
  ) => Effect.Effect<
    () => Effect.Effect<
      kendra.StartDataSourceSyncJobResponse,
      kendra.StartDataSourceSyncJobError
    >
  >
> {}
export const StartDataSourceSyncJob = Binding.Service<StartDataSourceSyncJob>(
  "AWS.Kendra.StartDataSourceSyncJob",
);
