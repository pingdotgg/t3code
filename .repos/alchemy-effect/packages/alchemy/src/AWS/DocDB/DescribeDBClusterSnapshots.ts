import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusterSnapshots` operation (IAM
 * action `rds:DescribeDBClusterSnapshots` — DocumentDB shares the RDS
 * control plane).
 *
 * Lists the account's DocumentDB cluster snapshots (optionally filtered by
 * cluster or snapshot identifier) with status and creation time embedded —
 * pairs with `CreateDBClusterSnapshot`/`DeleteDBClusterSnapshot` for backup
 * automation. Provide the implementation with
 * `Effect.provide(AWS.DocDB.DescribeDBClusterSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Poll a Snapshot until Available
 * ```typescript
 * const describeSnapshots = yield* DocDB.DescribeDBClusterSnapshots();
 *
 * const page = yield* describeSnapshots({
 *   DBClusterSnapshotIdentifier: "nightly-2026-07-15",
 * });
 * const status = page.DBClusterSnapshots?.[0]?.Status;
 * ```
 */
export interface DescribeDBClusterSnapshots extends Binding.Service<
  DescribeDBClusterSnapshots,
  "AWS.DocDB.DescribeDBClusterSnapshots",
  () => Effect.Effect<
    (
      request?: docdb.DescribeDBClusterSnapshotsMessage,
    ) => Effect.Effect<
      docdb.DBClusterSnapshotMessage,
      docdb.DescribeDBClusterSnapshotsError
    >
  >
> {}
export const DescribeDBClusterSnapshots =
  Binding.Service<DescribeDBClusterSnapshots>(
    "AWS.DocDB.DescribeDBClusterSnapshots",
  );
