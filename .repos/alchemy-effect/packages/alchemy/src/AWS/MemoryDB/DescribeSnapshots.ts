import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeSnapshots` operation (IAM action
 * `memorydb:DescribeSnapshots`).
 *
 * Lists the account's cluster snapshots, optionally filtered by cluster or
 * snapshot name — e.g. verifying a backup completed before a migration.
 * Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.DescribeSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List a Cluster's Snapshots
 * ```typescript
 * const describeSnapshots = yield* MemoryDB.DescribeSnapshots();
 *
 * const page = yield* describeSnapshots({ ClusterName: clusterName });
 * for (const snapshot of page.Snapshots ?? []) {
 *   yield* Effect.logInfo(`${snapshot.Name}: ${snapshot.Status}`);
 * }
 * ```
 */
export interface DescribeSnapshots extends Binding.Service<
  DescribeSnapshots,
  "AWS.MemoryDB.DescribeSnapshots",
  () => Effect.Effect<
    (
      request?: memorydb.DescribeSnapshotsRequest,
    ) => Effect.Effect<
      memorydb.DescribeSnapshotsResponse,
      memorydb.DescribeSnapshotsError
    >
  >
> {}
export const DescribeSnapshots = Binding.Service<DescribeSnapshots>(
  "AWS.MemoryDB.DescribeSnapshots",
);
