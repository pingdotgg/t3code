import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `ListAllowedNodeTypeUpdates` operation (IAM action
 * `memorydb:ListAllowedNodeTypeUpdates`), scoped to one {@link Cluster}.
 *
 * Lists the node types the bound cluster can scale up or down to — e.g.
 * right-sizing automation that checks the legal targets before calling
 * `UpdateCluster`. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.ListAllowedNodeTypeUpdatesHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example List the Cluster's Legal Node-Type Targets
 * ```typescript
 * const listAllowedNodeTypeUpdates =
 *   yield* MemoryDB.ListAllowedNodeTypeUpdates(cluster);
 *
 * const result = yield* listAllowedNodeTypeUpdates();
 * // result.ScaleUpNodeTypes / result.ScaleDownNodeTypes
 * ```
 */
export interface ListAllowedNodeTypeUpdates extends Binding.Service<
  ListAllowedNodeTypeUpdates,
  "AWS.MemoryDB.ListAllowedNodeTypeUpdates",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      memorydb.ListAllowedNodeTypeUpdatesResponse,
      memorydb.ListAllowedNodeTypeUpdatesError
    >
  >
> {}
export const ListAllowedNodeTypeUpdates =
  Binding.Service<ListAllowedNodeTypeUpdates>(
    "AWS.MemoryDB.ListAllowedNodeTypeUpdates",
  );
