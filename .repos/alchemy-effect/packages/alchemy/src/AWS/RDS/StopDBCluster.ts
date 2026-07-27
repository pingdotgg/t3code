import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `StopDBCluster` operation (IAM action
 * `rds:StopDBCluster`).
 *
 * Stops the bound {@link DBCluster} — e.g. an ops function that parks a
 * development cluster overnight to save cost. The cluster identifier is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.StopDBClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Stop a Running Cluster
 * ```typescript
 * // init — bind the operation to the cluster
 * const stopDBCluster = yield* AWS.RDS.StopDBCluster(cluster);
 *
 * // runtime
 * yield* stopDBCluster();
 * ```
 */
export interface StopDBCluster extends Binding.Service<
  StopDBCluster,
  "AWS.RDS.StopDBCluster",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    () => Effect.Effect<rds.StopDBClusterResult, rds.StopDBClusterError>
  >
> {}
export const StopDBCluster = Binding.Service<StopDBCluster>(
  "AWS.RDS.StopDBCluster",
);
