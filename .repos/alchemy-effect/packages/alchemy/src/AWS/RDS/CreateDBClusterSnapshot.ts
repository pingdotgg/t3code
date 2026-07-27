import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `CreateDBClusterSnapshot` operation (IAM actions
 * `rds:CreateDBClusterSnapshot` +
 * `rds:AddTagsToResource`).
 *
 * Takes a manual snapshot of the bound {@link DBCluster} — e.g. a
 * pre-migration backup function or a scheduled snapshot-rotation job. The
 * cluster identifier is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.CreateDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Cluster Snapshots
 * @example Take a Manual Cluster Snapshot
 * ```typescript
 * // init — bind the operation to the cluster
 * const createDBClusterSnapshot =
 *   yield* AWS.RDS.CreateDBClusterSnapshot(cluster);
 *
 * // runtime
 * yield* createDBClusterSnapshot({
 *   DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
 * });
 * ```
 */
export interface CreateDBClusterSnapshot extends Binding.Service<
  CreateDBClusterSnapshot,
  "AWS.RDS.CreateDBClusterSnapshot",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    (
      request: Omit<rds.CreateDBClusterSnapshotMessage, "DBClusterIdentifier">,
    ) => Effect.Effect<
      rds.CreateDBClusterSnapshotResult,
      rds.CreateDBClusterSnapshotError
    >
  >
> {}
export const CreateDBClusterSnapshot = Binding.Service<CreateDBClusterSnapshot>(
  "AWS.RDS.CreateDBClusterSnapshot",
);
