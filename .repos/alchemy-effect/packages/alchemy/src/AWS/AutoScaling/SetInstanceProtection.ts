import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `SetInstanceProtection` request with `AutoScalingGroupName` injected from
 * the bound {@link AutoScalingGroup}.
 */
export interface SetInstanceProtectionRequest extends Omit<
  autoscaling.SetInstanceProtectionQuery,
  "AutoScalingGroupName"
> {}

/**
 * Runtime binding for the `SetInstanceProtection` operation (IAM action
 * `autoscaling:SetInstanceProtection` scoped to the group ARN).
 *
 * Toggles scale-in protection on instances — e.g. a worker protects itself
 * while it processes a long-running job, then removes protection when idle so
 * the group may reclaim it. Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.SetInstanceProtectionHttp)`.
 * @binding
 * @section Scale-In Protection
 * @example Protect a busy worker from scale-in
 * ```typescript
 * // init — bind the operation to the group
 * const setInstanceProtection =
 *   yield* AWS.AutoScaling.SetInstanceProtection(group);
 *
 * // runtime — protect while working, release when idle
 * yield* setInstanceProtection({
 *   InstanceIds: [instanceId],
 *   ProtectedFromScaleIn: true,
 * });
 * ```
 */
export interface SetInstanceProtection extends Binding.Service<
  SetInstanceProtection,
  "AWS.AutoScaling.SetInstanceProtection",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    (
      request: SetInstanceProtectionRequest,
    ) => Effect.Effect<
      autoscaling.SetInstanceProtectionAnswer,
      autoscaling.SetInstanceProtectionError
    >
  >
> {}

export const SetInstanceProtection = Binding.Service<SetInstanceProtection>(
  "AWS.AutoScaling.SetInstanceProtection",
);
