import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `StartCluster` operation (IAM action
 * `docdb-elastic:StartCluster`), scoped to one {@link Cluster}.
 *
 * Restarts the bound elastic cluster after it was stopped — compute billing
 * resumes and the cluster transitions through `STARTING` back to `ACTIVE`.
 * Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.StartClusterHttp)`.
 * @binding
 * @section Starting and Stopping a Cluster
 * @example Start a Stopped Cluster
 * ```typescript
 * const startCluster = yield* DocDBElastic.StartCluster(cluster);
 *
 * const result = yield* startCluster();
 * // result.cluster.status → "STARTING"
 * ```
 */
export interface StartCluster extends Binding.Service<
  StartCluster,
  "AWS.DocDBElastic.StartCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      docdbelastic.StartClusterOutput,
      docdbelastic.StartClusterError
    >
  >
> {}
export const StartCluster = Binding.Service<StartCluster>(
  "AWS.DocDBElastic.StartCluster",
);
