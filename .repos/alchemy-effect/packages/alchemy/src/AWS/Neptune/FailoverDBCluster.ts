import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `FailoverDBCluster` operation (IAM action
 * `rds:FailoverDBCluster`).
 *
 * Forces a failover of the bound {@link DBCluster} — one of the read
 * replicas is promoted to primary — for resilience testing or to move the
 * writer to a specific instance. The cluster identifier is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Neptune.FailoverDBClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Force a Failover
 * ```typescript
 * // init — bind the operation to the cluster
 * const failoverDBCluster = yield* AWS.Neptune.FailoverDBCluster(cluster);
 *
 * // runtime — promote a specific replica
 * yield* failoverDBCluster({
 *   TargetDBInstanceIdentifier: replicaId,
 * });
 * ```
 */
export interface FailoverDBCluster extends Binding.Service<
  FailoverDBCluster,
  "AWS.Neptune.FailoverDBCluster",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    (
      request?: Omit<neptune.FailoverDBClusterMessage, "DBClusterIdentifier">,
    ) => Effect.Effect<
      neptune.FailoverDBClusterResult,
      neptune.FailoverDBClusterError
    >
  >
> {}
export const FailoverDBCluster = Binding.Service<FailoverDBCluster>(
  "AWS.Neptune.FailoverDBCluster",
);
