import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `SetDesiredCapacity` request with `AutoScalingGroupName` injected from the
 * bound {@link AutoScalingGroup}.
 */
export interface SetDesiredCapacityRequest extends Omit<
  autoscaling.SetDesiredCapacityType,
  "AutoScalingGroupName"
> {}

/**
 * Runtime binding for the `SetDesiredCapacity` operation (IAM action
 * `autoscaling:SetDesiredCapacity` scoped to the group ARN).
 *
 * Manually sets the size of the bound Auto Scaling Group — e.g. a Lambda that
 * scales a fleet up ahead of a known traffic spike or down to zero overnight.
 * Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.SetDesiredCapacityHttp)`.
 * @binding
 * @section Manual Scaling
 * @example Scale the fleet to a fixed size
 * ```typescript
 * // init — bind the operation to the group
 * const setDesiredCapacity = yield* AWS.AutoScaling.SetDesiredCapacity(group);
 *
 * // runtime — set the fleet size, honoring the group's cooldown
 * yield* setDesiredCapacity({ DesiredCapacity: 4, HonorCooldown: true });
 * ```
 */
export interface SetDesiredCapacity extends Binding.Service<
  SetDesiredCapacity,
  "AWS.AutoScaling.SetDesiredCapacity",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    (
      request: SetDesiredCapacityRequest,
    ) => Effect.Effect<
      autoscaling.SetDesiredCapacityResponse,
      autoscaling.SetDesiredCapacityError
    >
  >
> {}

export const SetDesiredCapacity = Binding.Service<SetDesiredCapacity>(
  "AWS.AutoScaling.SetDesiredCapacity",
);
