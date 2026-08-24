import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:RemoveAutoScalingPolicy` — detaches the automatic scaling policy from an instance group of the bound cluster.
 * @binding
 * @section Scaling the Cluster
 * @example Remove a Group's Auto Scaling
 * ```typescript
 * const removeAutoScaling = yield* AWS.EMR.RemoveAutoScalingPolicy(cluster);
 *
 * yield* removeAutoScaling({ InstanceGroupId: taskGroupId });
 * ```
 */
export interface RemoveAutoScalingPolicy extends Binding.Service<
  RemoveAutoScalingPolicy,
  "AWS.EMR.RemoveAutoScalingPolicy",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.RemoveAutoScalingPolicyInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.RemoveAutoScalingPolicyOutput,
      SVC.RemoveAutoScalingPolicyError
    >
  >
> {}
export const RemoveAutoScalingPolicy = Binding.Service<RemoveAutoScalingPolicy>(
  "AWS.EMR.RemoveAutoScalingPolicy",
);
