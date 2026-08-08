import type * as dax from "@distilled.cloud/aws/dax";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `IncreaseReplicationFactor` operation (IAM action
 * `dax:IncreaseReplicationFactor`), scoped to one {@link Cluster}.
 *
 * Adds read-replica nodes to the bound DAX cluster — the building block of
 * scale-out automation (e.g. a Lambda reacting to a CloudWatch alarm on
 * cluster CPU or cache-miss rate). Provide the implementation with
 * `Effect.provide(AWS.DAX.IncreaseReplicationFactorHttp)`.
 * @binding
 * @section Scaling a Cluster
 * @example Scale Out to Three Nodes
 * ```typescript
 * const increaseReplicationFactor =
 *   yield* DAX.IncreaseReplicationFactor(cluster);
 *
 * const result = yield* increaseReplicationFactor({
 *   NewReplicationFactor: 3,
 * });
 * // result.Cluster?.TotalNodes → 3 (new nodes provision asynchronously)
 * ```
 */
export interface IncreaseReplicationFactor extends Binding.Service<
  IncreaseReplicationFactor,
  "AWS.DAX.IncreaseReplicationFactor",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<dax.IncreaseReplicationFactorRequest, "ClusterName">,
    ) => Effect.Effect<
      dax.IncreaseReplicationFactorResponse,
      dax.IncreaseReplicationFactorError
    >
  >
> {}
export const IncreaseReplicationFactor =
  Binding.Service<IncreaseReplicationFactor>(
    "AWS.DAX.IncreaseReplicationFactor",
  );
