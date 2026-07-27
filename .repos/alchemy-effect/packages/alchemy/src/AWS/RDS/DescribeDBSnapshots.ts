import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBSnapshots` operation (IAM action
 * `rds:DescribeDBSnapshots`).
 *
 * Lists the account's DB instance snapshots — the discovery half of a
 * snapshot-rotation or verification function. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBSnapshotsHttp)`.
 * @binding
 * @section Managing Instance Snapshots
 * @example List an Instance's Manual Snapshots
 * ```typescript
 * const describeDBSnapshots = yield* AWS.RDS.DescribeDBSnapshots();
 *
 * const page = yield* describeDBSnapshots({
 *   DBInstanceIdentifier: instanceId,
 *   SnapshotType: "manual",
 * });
 * ```
 */
export interface DescribeDBSnapshots extends Binding.Service<
  DescribeDBSnapshots,
  "AWS.RDS.DescribeDBSnapshots",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBSnapshotsMessage,
    ) => Effect.Effect<rds.DBSnapshotMessage, rds.DescribeDBSnapshotsError>
  >
> {}
export const DescribeDBSnapshots = Binding.Service<DescribeDBSnapshots>(
  "AWS.RDS.DescribeDBSnapshots",
);
