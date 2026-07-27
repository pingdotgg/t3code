import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:PutManagedScalingPolicy` — attaches or replaces the bound cluster's managed scaling policy — EMR then resizes the cluster within the configured compute limits.
 * @binding
 * @section Scaling the Cluster
 * @example Enable Managed Scaling
 * ```typescript
 * const putScalingPolicy = yield* AWS.EMR.PutManagedScalingPolicy(cluster);
 *
 * yield* putScalingPolicy({
 *   ManagedScalingPolicy: {
 *     ComputeLimits: {
 *       UnitType: "Instances",
 *       MinimumCapacityUnits: 1,
 *       MaximumCapacityUnits: 10,
 *     },
 *   },
 * });
 * ```
 */
export interface PutManagedScalingPolicy extends Binding.Service<
  PutManagedScalingPolicy,
  "AWS.EMR.PutManagedScalingPolicy",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.PutManagedScalingPolicyInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.PutManagedScalingPolicyOutput,
      SVC.PutManagedScalingPolicyError
    >
  >
> {}
export const PutManagedScalingPolicy = Binding.Service<PutManagedScalingPolicy>(
  "AWS.EMR.PutManagedScalingPolicy",
);
