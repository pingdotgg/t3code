import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `ExecutePolicy` request with `AutoScalingGroupName` injected from the bound
 * {@link AutoScalingGroup}. `PolicyName` accepts either the policy name or its
 * ARN (e.g. `policy.policyArn` from a {@link ScalingPolicy}).
 */
export interface ExecutePolicyRequest extends Omit<
  autoscaling.ExecutePolicyType,
  "AutoScalingGroupName"
> {}

/**
 * Runtime binding for the `ExecutePolicy` operation (IAM action
 * `autoscaling:ExecutePolicy` scoped to the group ARN).
 *
 * Executes a step or simple scaling policy on the bound group — useful for
 * testing a policy's design or driving scaling from application logic.
 * Target-tracking policies cannot be executed manually. Provide the
 * implementation with `Effect.provide(AWS.AutoScaling.ExecutePolicyHttp)`.
 * @binding
 * @section Manual Scaling
 * @example Execute a step scaling policy
 * ```typescript
 * // init — bind the operation to the group
 * const executePolicy = yield* AWS.AutoScaling.ExecutePolicy(group);
 *
 * // runtime — trigger the policy with a synthetic metric breach
 * yield* executePolicy({
 *   PolicyName: "scale-out-on-cpu",
 *   MetricValue: 85,
 *   BreachThreshold: 80,
 * });
 * ```
 */
export interface ExecutePolicy extends Binding.Service<
  ExecutePolicy,
  "AWS.AutoScaling.ExecutePolicy",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    (
      request: ExecutePolicyRequest,
    ) => Effect.Effect<
      autoscaling.ExecutePolicyResponse,
      autoscaling.ExecutePolicyError
    >
  >
> {}

export const ExecutePolicy = Binding.Service<ExecutePolicy>(
  "AWS.AutoScaling.ExecutePolicy",
);
