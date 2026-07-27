import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `ResumeCluster` operation (IAM action
 * `redshift:ResumeCluster`).
 *
 * Resumes the bound paused {@link Cluster} — the morning half of an
 * overnight pause schedule. The cluster identifier is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Redshift.ResumeClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Resume the Warehouse in the Morning
 * ```typescript
 * // init — bind the operation to the cluster
 * const resumeCluster = yield* AWS.Redshift.ResumeCluster(cluster);
 *
 * // runtime
 * yield* resumeCluster();
 * ```
 */
export interface ResumeCluster extends Binding.Service<
  ResumeCluster,
  "AWS.Redshift.ResumeCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      redshift.ResumeClusterResult,
      redshift.ResumeClusterError
    >
  >
> {}
export const ResumeCluster = Binding.Service<ResumeCluster>(
  "AWS.Redshift.ResumeCluster",
);
