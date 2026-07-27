import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

/**
 * Runtime binding for `quicksight:DescribeDashboardSnapshotJob`.
 *
 * Reads the status (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`) and
 * configuration of a snapshot job started on the bound {@link Dashboard}.
 * `AwsAccountId` and `DashboardId` are injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.QuickSight.DescribeDashboardSnapshotJobHttp)`.
 * @binding
 * @section Dashboard Snapshots
 * @example Poll A Snapshot Job Until It Completes
 * ```typescript
 * // init — bind the operation to the dashboard
 * const describeSnapshotJob =
 *   yield* AWS.QuickSight.DescribeDashboardSnapshotJob(dashboard);
 *
 * // runtime
 * const job = yield* describeSnapshotJob({ SnapshotJobId: jobId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("5 seconds"),
 *     until: (j) => j.JobStatus === "COMPLETED" || j.JobStatus === "FAILED",
 *     times: 24,
 *   }),
 * );
 * ```
 */
export interface DescribeDashboardSnapshotJob extends Binding.Service<
  DescribeDashboardSnapshotJob,
  "AWS.QuickSight.DescribeDashboardSnapshotJob",
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request: Omit<
        quicksight.DescribeDashboardSnapshotJobRequest,
        "AwsAccountId" | "DashboardId"
      >,
    ) => Effect.Effect<
      quicksight.DescribeDashboardSnapshotJobResponse,
      quicksight.DescribeDashboardSnapshotJobError
    >
  >
> {}
export const DescribeDashboardSnapshotJob =
  Binding.Service<DescribeDashboardSnapshotJob>(
    "AWS.QuickSight.DescribeDashboardSnapshotJob",
  );
