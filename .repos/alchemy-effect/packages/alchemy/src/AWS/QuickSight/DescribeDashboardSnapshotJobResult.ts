import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

/**
 * Runtime binding for `quicksight:DescribeDashboardSnapshotJobResult`.
 *
 * Fetches the result of a `COMPLETED` snapshot job on the bound
 * {@link Dashboard} — the S3 destination or pre-signed download URLs of the
 * generated files, or the error details of a `FAILED` job. `AwsAccountId`
 * and `DashboardId` are injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.QuickSight.DescribeDashboardSnapshotJobResultHttp)`.
 * @binding
 * @section Dashboard Snapshots
 * @example Download A Completed Snapshot
 * ```typescript
 * // init — bind the operation to the dashboard
 * const describeSnapshotJobResult =
 *   yield* AWS.QuickSight.DescribeDashboardSnapshotJobResult(dashboard);
 *
 * // runtime
 * const { Result } = yield* describeSnapshotJobResult({
 *   SnapshotJobId: jobId,
 * });
 * const url = Result?.AnonymousUsers?.[0]?.FileGroups?.[0]?.Files?.[0];
 * ```
 */
export interface DescribeDashboardSnapshotJobResult extends Binding.Service<
  DescribeDashboardSnapshotJobResult,
  "AWS.QuickSight.DescribeDashboardSnapshotJobResult",
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request: Omit<
        quicksight.DescribeDashboardSnapshotJobResultRequest,
        "AwsAccountId" | "DashboardId"
      >,
    ) => Effect.Effect<
      quicksight.DescribeDashboardSnapshotJobResultResponse,
      quicksight.DescribeDashboardSnapshotJobResultError
    >
  >
> {}
export const DescribeDashboardSnapshotJobResult =
  Binding.Service<DescribeDashboardSnapshotJobResult>(
    "AWS.QuickSight.DescribeDashboardSnapshotJobResult",
  );
