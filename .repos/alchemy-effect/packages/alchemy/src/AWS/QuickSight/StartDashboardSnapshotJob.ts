import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

/**
 * Runtime binding for `quicksight:StartDashboardSnapshotJob`.
 *
 * Starts an asynchronous snapshot job that exports the bound
 * {@link Dashboard} as a PDF, CSV, or Excel file delivered to S3 or returned
 * as a download URL. `AwsAccountId` and `DashboardId` are injected from the
 * binding; poll the job with
 * {@link DescribeDashboardSnapshotJob | AWS.QuickSight.DescribeDashboardSnapshotJob}.
 * Provide the implementation with
 * `Effect.provide(AWS.QuickSight.StartDashboardSnapshotJobHttp)`.
 * @binding
 * @section Dashboard Snapshots
 * @example Start A PDF Snapshot
 * ```typescript
 * // init — bind the operation to the dashboard
 * const startSnapshotJob =
 *   yield* AWS.QuickSight.StartDashboardSnapshotJob(dashboard);
 *
 * // runtime
 * const { SnapshotJobId } = yield* startSnapshotJob({
 *   SnapshotJobId: crypto.randomUUID(),
 *   UserConfiguration: { AnonymousUsers: [] },
 *   SnapshotConfiguration: {
 *     FileGroups: [{ Files: [{ FormatType: "PDF" }] }],
 *   },
 * });
 * ```
 */
export interface StartDashboardSnapshotJob extends Binding.Service<
  StartDashboardSnapshotJob,
  "AWS.QuickSight.StartDashboardSnapshotJob",
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request: Omit<
        quicksight.StartDashboardSnapshotJobRequest,
        "AwsAccountId" | "DashboardId"
      >,
    ) => Effect.Effect<
      quicksight.StartDashboardSnapshotJobResponse,
      quicksight.StartDashboardSnapshotJobError
    >
  >
> {}
export const StartDashboardSnapshotJob =
  Binding.Service<StartDashboardSnapshotJob>(
    "AWS.QuickSight.StartDashboardSnapshotJob",
  );
