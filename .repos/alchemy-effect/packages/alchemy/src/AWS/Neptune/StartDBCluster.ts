import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `StartDBCluster` operation (IAM action
 * `rds:StartDBCluster`).
 *
 * Starts the bound {@link DBCluster} after it was stopped — e.g. an ops
 * function that wakes a development cluster on a schedule. The cluster
 * identifier is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Neptune.StartDBClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Start a Stopped Cluster
 * ```typescript
 * // init — bind the operation to the cluster
 * const startDBCluster = yield* AWS.Neptune.StartDBCluster(cluster);
 *
 * // runtime
 * yield* startDBCluster();
 * ```
 */
export interface StartDBCluster extends Binding.Service<
  StartDBCluster,
  "AWS.Neptune.StartDBCluster",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      neptune.StartDBClusterResult,
      neptune.StartDBClusterError
    >
  >
> {}
export const StartDBCluster = Binding.Service<StartDBCluster>(
  "AWS.Neptune.StartDBCluster",
);
