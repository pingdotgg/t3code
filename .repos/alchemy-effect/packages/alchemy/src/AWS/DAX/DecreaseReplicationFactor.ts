import type * as dax from "@distilled.cloud/aws/dax";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `DecreaseReplicationFactor` operation (IAM action
 * `dax:DecreaseReplicationFactor`), scoped to one {@link Cluster}.
 *
 * Removes read-replica nodes from the bound DAX cluster — the scale-in half
 * of node-count automation (e.g. shrinking a cluster off-peak to cut
 * node-hour cost). Provide the implementation with
 * `Effect.provide(AWS.DAX.DecreaseReplicationFactorHttp)`.
 * @binding
 * @section Scaling a Cluster
 * @example Scale In to One Node
 * ```typescript
 * const decreaseReplicationFactor =
 *   yield* DAX.DecreaseReplicationFactor(cluster);
 *
 * const result = yield* decreaseReplicationFactor({
 *   NewReplicationFactor: 1,
 * });
 * // result.Cluster?.TotalNodes → 1 once the removal completes
 * ```
 */
export interface DecreaseReplicationFactor extends Binding.Service<
  DecreaseReplicationFactor,
  "AWS.DAX.DecreaseReplicationFactor",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<dax.DecreaseReplicationFactorRequest, "ClusterName">,
    ) => Effect.Effect<
      dax.DecreaseReplicationFactorResponse,
      dax.DecreaseReplicationFactorError
    >
  >
> {}
export const DecreaseReplicationFactor =
  Binding.Service<DecreaseReplicationFactor>(
    "AWS.DAX.DecreaseReplicationFactor",
  );
