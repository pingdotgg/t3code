import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `CreateDBClusterSnapshot` operation (IAM action
 * `rds:CreateDBClusterSnapshot`).
 *
 * Takes an on-demand snapshot of the bound {@link DBCluster} — e.g. a backup
 * function that snapshots before a risky migration. The cluster identifier
 * is injected from the binding; the grant covers both the cluster ARN and
 * the account's `cluster-snapshot` ARN space (both resources must be allowed
 * for snapshot creation). Provide the implementation with
 * `Effect.provide(AWS.DocDB.CreateDBClusterSnapshotHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Snapshot Before a Migration
 * ```typescript
 * // init — bind the operation to the cluster
 * const createDBClusterSnapshot =
 *   yield* AWS.DocDB.CreateDBClusterSnapshot(cluster);
 *
 * // runtime
 * const { DBClusterSnapshot } = yield* createDBClusterSnapshot({
 *   DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
 * });
 * ```
 */
export interface CreateDBClusterSnapshot extends Binding.Service<
  CreateDBClusterSnapshot,
  "AWS.DocDB.CreateDBClusterSnapshot",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    (
      request: Omit<
        docdb.CreateDBClusterSnapshotMessage,
        "DBClusterIdentifier"
      >,
    ) => Effect.Effect<
      docdb.CreateDBClusterSnapshotResult,
      docdb.CreateDBClusterSnapshotError
    >
  >
> {}
export const CreateDBClusterSnapshot = Binding.Service<CreateDBClusterSnapshot>(
  "AWS.DocDB.CreateDBClusterSnapshot",
);
