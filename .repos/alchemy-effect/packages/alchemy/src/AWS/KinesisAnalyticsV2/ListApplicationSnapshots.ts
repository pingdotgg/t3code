import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface ListApplicationSnapshotsRequest extends Omit<
  SVC.ListApplicationSnapshotsRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:ListApplicationSnapshots` — pages
 * through the bound application's snapshots, e.g. to find the newest
 * savepoint or prune old ones with {@link DeleteApplicationSnapshot}.
 * @binding
 * @section Managing Snapshots
 * @example List snapshots
 * ```typescript
 * const listSnapshots = yield* AWS.KinesisAnalyticsV2.ListApplicationSnapshots(app);
 *
 * const { SnapshotSummaries } = yield* listSnapshots({ Limit: 50 });
 * ```
 */
export interface ListApplicationSnapshots extends Binding.Service<
  ListApplicationSnapshots,
  "AWS.KinesisAnalyticsV2.ListApplicationSnapshots",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: ListApplicationSnapshotsRequest,
    ) => Effect.Effect<
      SVC.ListApplicationSnapshotsResponse,
      SVC.ListApplicationSnapshotsError
    >
  >
> {}
export const ListApplicationSnapshots =
  Binding.Service<ListApplicationSnapshots>(
    "AWS.KinesisAnalyticsV2.ListApplicationSnapshots",
  );
