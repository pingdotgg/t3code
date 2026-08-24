import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface CreateApplicationSnapshotRequest extends Omit<
  SVC.CreateApplicationSnapshotRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:CreateApplicationSnapshot` — takes
 * a snapshot (Flink savepoint) of the bound application's state on demand,
 * e.g. a scheduled backup ahead of a deploy. The application must be
 * `RUNNING` with snapshots enabled; poll the result with
 * {@link DescribeApplicationSnapshot}.
 * @binding
 * @section Managing Snapshots
 * @example Take a savepoint before a deploy
 * ```typescript
 * const createSnapshot = yield* AWS.KinesisAnalyticsV2.CreateApplicationSnapshot(app);
 *
 * yield* createSnapshot({ SnapshotName: "pre-deploy" });
 * ```
 */
export interface CreateApplicationSnapshot extends Binding.Service<
  CreateApplicationSnapshot,
  "AWS.KinesisAnalyticsV2.CreateApplicationSnapshot",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: CreateApplicationSnapshotRequest,
    ) => Effect.Effect<
      SVC.CreateApplicationSnapshotResponse,
      SVC.CreateApplicationSnapshotError
    >
  >
> {}
export const CreateApplicationSnapshot =
  Binding.Service<CreateApplicationSnapshot>(
    "AWS.KinesisAnalyticsV2.CreateApplicationSnapshot",
  );
