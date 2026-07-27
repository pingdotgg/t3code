import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `FailoverDBCluster` operation (IAM action
 * `rds:FailoverDBCluster`).
 *
 * Forces a failover of the bound {@link DBCluster} — promotes a reader to
 * writer, e.g. for chaos testing or AZ evacuation. The cluster identifier
 * is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.FailoverDBClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Force a Failover
 * ```typescript
 * // init — bind the operation to the cluster
 * const failoverDBCluster = yield* AWS.RDS.FailoverDBCluster(cluster);
 *
 * // runtime
 * yield* failoverDBCluster();
 * ```
 */
export interface FailoverDBCluster extends Binding.Service<
  FailoverDBCluster,
  "AWS.RDS.FailoverDBCluster",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    (
      request?: Omit<rds.FailoverDBClusterMessage, "DBClusterIdentifier">,
    ) => Effect.Effect<rds.FailoverDBClusterResult, rds.FailoverDBClusterError>
  >
> {}
export const FailoverDBCluster = Binding.Service<FailoverDBCluster>(
  "AWS.RDS.FailoverDBCluster",
);
