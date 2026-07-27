import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `CreateSnapshot` operation (IAM actions
 * `memorydb:CreateSnapshot` + `memorydb:TagResource`), scoped to one
 * {@link Cluster}.
 *
 * Takes an on-demand snapshot of the bound cluster — e.g. a pre-migration
 * backup from an operational Lambda. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.CreateSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take an On-Demand Snapshot
 * ```typescript
 * const createSnapshot = yield* MemoryDB.CreateSnapshot(cluster);
 *
 * const result = yield* createSnapshot({ SnapshotName: "pre-migration" });
 * // result.Snapshot.Status → "creating"
 * ```
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "AWS.MemoryDB.CreateSnapshot",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<memorydb.CreateSnapshotRequest, "ClusterName">,
    ) => Effect.Effect<
      memorydb.CreateSnapshotResponse,
      memorydb.CreateSnapshotError
    >
  >
> {}
export const CreateSnapshot = Binding.Service<CreateSnapshot>(
  "AWS.MemoryDB.CreateSnapshot",
);
