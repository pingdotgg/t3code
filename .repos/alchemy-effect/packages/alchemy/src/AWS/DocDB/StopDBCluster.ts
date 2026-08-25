import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Runtime binding for the `StopDBCluster` operation (IAM action
 * `rds:StopDBCluster`).
 *
 * Stops the bound {@link DBCluster} — compute billing pauses while storage
 * is retained (up to 7 days, after which DocumentDB starts it back up) —
 * e.g. an ops function that parks a development cluster overnight. The
 * cluster identifier is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.DocDB.StopDBClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Stop a Running Cluster
 * ```typescript
 * // init — bind the operation to the cluster
 * const stopDBCluster = yield* AWS.DocDB.StopDBCluster(cluster);
 *
 * // runtime
 * yield* stopDBCluster();
 * ```
 */
export interface StopDBCluster extends Binding.Service<
  StopDBCluster,
  "AWS.DocDB.StopDBCluster",
  (
    cluster: DBCluster,
  ) => Effect.Effect<
    () => Effect.Effect<docdb.StopDBClusterResult, docdb.StopDBClusterError>
  >
> {}
export const StopDBCluster = Binding.Service<StopDBCluster>(
  "AWS.DocDB.StopDBCluster",
);
