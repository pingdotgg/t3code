import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:PutAutoScalingPolicy` — attaches a CloudWatch-driven automatic scaling policy to an instance group of the bound cluster.
 * @binding
 * @section Scaling the Cluster
 * @example Scale a Task Group on YARN Memory
 * ```typescript
 * const putAutoScaling = yield* AWS.EMR.PutAutoScalingPolicy(cluster);
 *
 * yield* putAutoScaling({
 *   InstanceGroupId: taskGroupId,
 *   AutoScalingPolicy: {
 *     Constraints: { MinCapacity: 0, MaxCapacity: 8 },
 *     Rules: [], // CloudWatch alarm-driven rules
 *   },
 * });
 * ```
 */
export interface PutAutoScalingPolicy extends Binding.Service<
  PutAutoScalingPolicy,
  "AWS.EMR.PutAutoScalingPolicy",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.PutAutoScalingPolicyInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.PutAutoScalingPolicyOutput,
      SVC.PutAutoScalingPolicyError
    >
  >
> {}
export const PutAutoScalingPolicy = Binding.Service<PutAutoScalingPolicy>(
  "AWS.EMR.PutAutoScalingPolicy",
);
