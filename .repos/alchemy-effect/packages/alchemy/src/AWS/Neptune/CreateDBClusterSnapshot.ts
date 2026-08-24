import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `CreateDBClusterSnapshot` operation (IAM actions
 * `rds:CreateDBClusterSnapshot` + `rds:AddTagsToResource`).
 *
 * Takes a manual snapshot of the bound {@link DBCluster} — e.g. a
 * pre-migration backup function or a scheduled snapshot-rotation job. The
 * cluster identifier is injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.Neptune.CreateDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take a Manual Snapshot
 * ```typescript
 * // init — bind the operation to the cluster
 * const createDBClusterSnapshot =
 *   yield* AWS.Neptune.CreateDBClusterSnapshot(cluster);
 *
 * // runtime
 * yield* createDBClusterSnapshot({
 *   DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
 * });
 * ```
 */
export interface CreateDBClusterSnapshot extends Binding.Service<
  CreateDBClusterSnapshot,
  "AWS.Neptune.CreateDBClusterSnapshot",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    (
      request?: Omit<
        neptune.CreateDBClusterSnapshotMessage,
        "DBClusterIdentifier"
      >,
    ) => Effect.Effect<
      neptune.CreateDBClusterSnapshotResult,
      neptune.CreateDBClusterSnapshotError
    >
  >
> {}
export const CreateDBClusterSnapshot = Binding.Service<CreateDBClusterSnapshot>(
  "AWS.Neptune.CreateDBClusterSnapshot",
);
