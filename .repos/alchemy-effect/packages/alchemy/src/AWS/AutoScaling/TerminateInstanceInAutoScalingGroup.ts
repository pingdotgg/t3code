import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `TerminateInstanceInAutoScalingGroup` request. The operation is
 * instance-scoped — EC2 Auto Scaling resolves the instance's owning group for
 * authorization, which the binding grants on the bound
 * {@link AutoScalingGroup}'s ARN.
 */
export interface TerminateInstanceRequest
  extends autoscaling.TerminateInstanceInAutoScalingGroupType {}

/**
 * Runtime binding for the `TerminateInstanceInAutoScalingGroup` operation
 * (IAM action `autoscaling:TerminateInstanceInAutoScalingGroup` scoped to the
 * group ARN).
 *
 * Requests termination of a specific instance, optionally decrementing the
 * desired capacity — e.g. recycling a wedged worker (the group launches a
 * replacement) or retiring the instance it runs on. Provide the
 * implementation with
 * `Effect.provide(AWS.AutoScaling.TerminateInstanceInAutoScalingGroupHttp)`.
 * @binding
 * @section Manual Scaling
 * @example Recycle a wedged instance
 * ```typescript
 * // init — bind the operation to the group
 * const terminateInstance =
 *   yield* AWS.AutoScaling.TerminateInstanceInAutoScalingGroup(group);
 *
 * // runtime — terminate and let the group launch a replacement
 * const { Activity } = yield* terminateInstance({
 *   InstanceId: instanceId,
 *   ShouldDecrementDesiredCapacity: false,
 * });
 * ```
 */
export interface TerminateInstanceInAutoScalingGroup extends Binding.Service<
  TerminateInstanceInAutoScalingGroup,
  "AWS.AutoScaling.TerminateInstanceInAutoScalingGroup",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    (
      request: TerminateInstanceRequest,
    ) => Effect.Effect<
      autoscaling.ActivityType,
      autoscaling.TerminateInstanceInAutoScalingGroupError
    >
  >
> {}

export const TerminateInstanceInAutoScalingGroup =
  Binding.Service<TerminateInstanceInAutoScalingGroup>(
    "AWS.AutoScaling.TerminateInstanceInAutoScalingGroup",
  );
