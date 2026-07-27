import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `CreateClusterSnapshot` operation (IAM action
 * `redshift:CreateClusterSnapshot` on the cluster and its
 * `snapshot:{cluster}/*` ARNs).
 *
 * Takes a manual snapshot of the bound {@link Cluster} — e.g. a
 * pre-migration backup function or a scheduled snapshot-rotation job. The
 * cluster identifier is injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.Redshift.CreateClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take a Manual Snapshot
 * ```typescript
 * // init — bind the operation to the cluster
 * const createClusterSnapshot =
 *   yield* AWS.Redshift.CreateClusterSnapshot(cluster);
 *
 * // runtime
 * yield* createClusterSnapshot({
 *   SnapshotIdentifier: `pre-migration-${runId}`,
 * });
 * ```
 */
export interface CreateClusterSnapshot extends Binding.Service<
  CreateClusterSnapshot,
  "AWS.Redshift.CreateClusterSnapshot",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<redshift.CreateClusterSnapshotMessage, "ClusterIdentifier">,
    ) => Effect.Effect<
      redshift.CreateClusterSnapshotResult,
      redshift.CreateClusterSnapshotError
    >
  >
> {}
export const CreateClusterSnapshot = Binding.Service<CreateClusterSnapshot>(
  "AWS.Redshift.CreateClusterSnapshot",
);
