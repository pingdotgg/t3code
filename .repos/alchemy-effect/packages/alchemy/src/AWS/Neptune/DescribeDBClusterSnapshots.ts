import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusterSnapshots` operation (IAM action
 * `rds:DescribeDBClusterSnapshots`).
 *
 * Lists the account's Neptune cluster snapshots (manual and automated) —
 * for backup verification and restore tooling. Provide the implementation
 * with `Effect.provide(AWS.Neptune.DescribeDBClusterSnapshotsHttp)`.
 * ### Managing Snapshots
 * **Example:** List a Cluster's Snapshots
 * ```typescript
 * const describeDBClusterSnapshots =
 *   yield* AWS.Neptune.DescribeDBClusterSnapshots();
 *
 * const page = yield* describeDBClusterSnapshots({
 *   DBClusterIdentifier: clusterId,
 * });
 * const count = page.DBClusterSnapshots?.length;
 * ```
 *
 * @binding
 */
export interface DescribeDBClusterSnapshots extends Binding.Service<
  DescribeDBClusterSnapshots,
  "AWS.Neptune.DescribeDBClusterSnapshots",
  () => Effect.Effect<
    (
      request?: neptune.DescribeDBClusterSnapshotsMessage,
    ) => Effect.Effect<
      neptune.DBClusterSnapshotMessage,
      neptune.DescribeDBClusterSnapshotsError
    >
  >
> {}
export const DescribeDBClusterSnapshots =
  Binding.Service<DescribeDBClusterSnapshots>(
    "AWS.Neptune.DescribeDBClusterSnapshots",
  );
