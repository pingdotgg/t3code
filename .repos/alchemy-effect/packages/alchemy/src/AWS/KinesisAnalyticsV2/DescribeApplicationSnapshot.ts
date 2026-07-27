import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface DescribeApplicationSnapshotRequest extends Omit<
  SVC.DescribeApplicationSnapshotRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:DescribeApplicationSnapshot` —
 * reads a snapshot's status (`CREATING` → `READY` / `FAILED`), e.g. to poll
 * a savepoint taken with {@link CreateApplicationSnapshot} to completion.
 * @binding
 * @section Managing Snapshots
 * @example Poll a snapshot until READY
 * ```typescript
 * const describeSnapshot = yield* AWS.KinesisAnalyticsV2.DescribeApplicationSnapshot(app);
 *
 * const { SnapshotDetails } = yield* describeSnapshot({
 *   SnapshotName: "pre-deploy",
 * });
 * ```
 */
export interface DescribeApplicationSnapshot extends Binding.Service<
  DescribeApplicationSnapshot,
  "AWS.KinesisAnalyticsV2.DescribeApplicationSnapshot",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: DescribeApplicationSnapshotRequest,
    ) => Effect.Effect<
      SVC.DescribeApplicationSnapshotResponse,
      SVC.DescribeApplicationSnapshotError
    >
  >
> {}
export const DescribeApplicationSnapshot =
  Binding.Service<DescribeApplicationSnapshot>(
    "AWS.KinesisAnalyticsV2.DescribeApplicationSnapshot",
  );
