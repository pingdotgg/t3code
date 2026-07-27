import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `RebootCluster` operation (IAM action
 * `redshift:RebootCluster`).
 *
 * Reboots the bound {@link Cluster} (a momentary outage while it restarts) —
 * e.g. an ops function that applies pending static parameter-group changes.
 * The cluster identifier is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Redshift.RebootClusterHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Reboot to Apply Static Parameters
 * ```typescript
 * // init — bind the operation to the cluster
 * const rebootCluster = yield* AWS.Redshift.RebootCluster(cluster);
 *
 * // runtime
 * yield* rebootCluster();
 * ```
 */
export interface RebootCluster extends Binding.Service<
  RebootCluster,
  "AWS.Redshift.RebootCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    () => Effect.Effect<
      redshift.RebootClusterResult,
      redshift.RebootClusterError
    >
  >
> {}
export const RebootCluster = Binding.Service<RebootCluster>(
  "AWS.Redshift.RebootCluster",
);
