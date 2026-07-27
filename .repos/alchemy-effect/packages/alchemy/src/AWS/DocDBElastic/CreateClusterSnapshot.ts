import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `CreateClusterSnapshot` operation (IAM actions
 * `docdb-elastic:CreateClusterSnapshot` + `docdb-elastic:TagResource`),
 * scoped to one {@link Cluster}.
 *
 * Takes an on-demand manual snapshot of the bound elastic cluster — e.g. a
 * pre-migration backup from an operational Lambda. Provide the
 * implementation with
 * `Effect.provide(AWS.DocDBElastic.CreateClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take an On-Demand Snapshot
 * ```typescript
 * const createSnapshot = yield* DocDBElastic.CreateClusterSnapshot(cluster);
 *
 * const result = yield* createSnapshot({ snapshotName: "pre-migration" });
 * // result.snapshot.status → "CREATING"
 * ```
 */
export interface CreateClusterSnapshot extends Binding.Service<
  CreateClusterSnapshot,
  "AWS.DocDBElastic.CreateClusterSnapshot",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<docdbelastic.CreateClusterSnapshotInput, "clusterArn">,
    ) => Effect.Effect<
      docdbelastic.CreateClusterSnapshotOutput,
      docdbelastic.CreateClusterSnapshotError
    >
  >
> {}
export const CreateClusterSnapshot = Binding.Service<CreateClusterSnapshot>(
  "AWS.DocDBElastic.CreateClusterSnapshot",
);
