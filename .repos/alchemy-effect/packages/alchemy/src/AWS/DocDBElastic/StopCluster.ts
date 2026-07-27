import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `StopCluster` operation (IAM action
 * `docdb-elastic:StopCluster`), scoped to one {@link Cluster}.
 *
 * Stops the bound elastic cluster — compute billing pauses (storage is still
 * billed) and the cluster transitions through `STOPPING` to `STOPPED`. Use
 * from a scheduled Lambda to park non-production clusters outside working
 * hours. Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.StopClusterHttp)`.
 * @binding
 * @section Starting and Stopping a Cluster
 * @example Stop a Running Cluster
 * ```typescript
 * const stopCluster = yield* DocDBElastic.StopCluster(cluster);
 *
 * const result = yield* stopCluster();
 * // result.cluster.status → "STOPPING"
 * ```
 */
export interface StopCluster extends Binding.Service<
  StopCluster,
  "AWS.DocDBElastic.StopCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      docdbelastic.StopClusterOutput,
      docdbelastic.StopClusterError
    >
  >
> {}
export const StopCluster = Binding.Service<StopCluster>(
  "AWS.DocDBElastic.StopCluster",
);
