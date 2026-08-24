import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListClusterSnapshots` operation (IAM action
 * `docdb-elastic:ListClusterSnapshots`).
 *
 * Lists the account's elastic-cluster snapshots (one page per call —
 * `nextToken` continues), optionally filtered to one cluster's ARN or to
 * `manual`/`automated` snapshots. Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.ListClusterSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List a Cluster's Manual Snapshots
 * ```typescript
 * const listSnapshots = yield* DocDBElastic.ListClusterSnapshots();
 *
 * const page = yield* listSnapshots({
 *   clusterArn: cluster.clusterArn,
 *   snapshotType: "manual",
 * });
 * for (const snapshot of page.snapshots ?? []) {
 *   yield* Effect.logInfo(`${snapshot.snapshotName}: ${snapshot.status}`);
 * }
 * ```
 */
export interface ListClusterSnapshots extends Binding.Service<
  ListClusterSnapshots,
  "AWS.DocDBElastic.ListClusterSnapshots",
  () => Effect.Effect<
    (
      request?: docdbelastic.ListClusterSnapshotsInput,
    ) => Effect.Effect<
      docdbelastic.ListClusterSnapshotsOutput,
      docdbelastic.ListClusterSnapshotsError
    >
  >
> {}
export const ListClusterSnapshots = Binding.Service<ListClusterSnapshots>(
  "AWS.DocDBElastic.ListClusterSnapshots",
);
