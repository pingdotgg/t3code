import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `PauseCluster` operation (IAM action
 * `redshift:PauseCluster`).
 *
 * Pauses the bound {@link Cluster} (compute billing stops, storage
 * persists) — e.g. a scheduled ops function that parks the warehouse
 * overnight to save cost. The cluster identifier is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Redshift.PauseClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Pause the Warehouse Overnight
 * ```typescript
 * // init — bind the operation to the cluster
 * const pauseCluster = yield* AWS.Redshift.PauseCluster(cluster);
 *
 * // runtime
 * yield* pauseCluster();
 * ```
 */
export interface PauseCluster extends Binding.Service<
  PauseCluster,
  "AWS.Redshift.PauseCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    () => Effect.Effect<redshift.PauseClusterResult, redshift.PauseClusterError>
  >
> {}
export const PauseCluster = Binding.Service<PauseCluster>(
  "AWS.Redshift.PauseCluster",
);
