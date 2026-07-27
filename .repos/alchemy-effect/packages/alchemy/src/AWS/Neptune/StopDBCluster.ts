import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `StopDBCluster` operation (IAM action
 * `rds:StopDBCluster`).
 *
 * Stops the bound {@link DBCluster} (compute pauses, storage persists) —
 * e.g. an ops function that parks a development cluster overnight to save
 * cost. The cluster identifier is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Neptune.StopDBClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Stop a Running Cluster
 * ```typescript
 * // init — bind the operation to the cluster
 * const stopDBCluster = yield* AWS.Neptune.StopDBCluster(cluster);
 *
 * // runtime
 * yield* stopDBCluster();
 * ```
 */
export interface StopDBCluster extends Binding.Service<
  StopDBCluster,
  "AWS.Neptune.StopDBCluster",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    () => Effect.Effect<neptune.StopDBClusterResult, neptune.StopDBClusterError>
  >
> {}
export const StopDBCluster = Binding.Service<StopDBCluster>(
  "AWS.Neptune.StopDBCluster",
);
