import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:RemoveManagedScalingPolicy` — detaches the bound cluster's managed scaling policy.
 * @binding
 * @section Scaling the Cluster
 * @example Disable Managed Scaling
 * ```typescript
 * const removeScalingPolicy =
 *   yield* AWS.EMR.RemoveManagedScalingPolicy(cluster);
 *
 * yield* removeScalingPolicy();
 * ```
 */
export interface RemoveManagedScalingPolicy extends Binding.Service<
  RemoveManagedScalingPolicy,
  "AWS.EMR.RemoveManagedScalingPolicy",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.RemoveManagedScalingPolicyInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.RemoveManagedScalingPolicyOutput,
      SVC.RemoveManagedScalingPolicyError
    >
  >
> {}
export const RemoveManagedScalingPolicy =
  Binding.Service<RemoveManagedScalingPolicy>(
    "AWS.EMR.RemoveManagedScalingPolicy",
  );
