import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface DeleteApplicationSnapshotRequest extends Omit<
  SVC.DeleteApplicationSnapshotRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:DeleteApplicationSnapshot` —
 * deletes a snapshot of the bound application, e.g. pruning old savepoints
 * on a retention schedule. The `SnapshotCreationTimestamp` acts as a
 * compare-and-set token; read it fresh with
 * {@link DescribeApplicationSnapshot} or {@link ListApplicationSnapshots}.
 * @binding
 * @section Managing Snapshots
 * @example Prune a snapshot
 * ```typescript
 * const describeSnapshot = yield* AWS.KinesisAnalyticsV2.DescribeApplicationSnapshot(app);
 * const deleteSnapshot = yield* AWS.KinesisAnalyticsV2.DeleteApplicationSnapshot(app);
 *
 * const { SnapshotDetails } = yield* describeSnapshot({ SnapshotName: "old" });
 * yield* deleteSnapshot({
 *   SnapshotName: "old",
 *   SnapshotCreationTimestamp: SnapshotDetails.SnapshotCreationTimestamp!,
 * });
 * ```
 */
export interface DeleteApplicationSnapshot extends Binding.Service<
  DeleteApplicationSnapshot,
  "AWS.KinesisAnalyticsV2.DeleteApplicationSnapshot",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: DeleteApplicationSnapshotRequest,
    ) => Effect.Effect<
      SVC.DeleteApplicationSnapshotResponse,
      SVC.DeleteApplicationSnapshotError
    >
  >
> {}
export const DeleteApplicationSnapshot =
  Binding.Service<DeleteApplicationSnapshot>(
    "AWS.KinesisAnalyticsV2.DeleteApplicationSnapshot",
  );
