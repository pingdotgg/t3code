import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `SetInstanceHealth` request. The operation is instance-scoped — EC2 Auto
 * Scaling resolves the instance's owning group for authorization, which the
 * binding grants on the bound {@link AutoScalingGroup}'s ARN.
 */
export interface SetInstanceHealthRequest
  extends autoscaling.SetInstanceHealthQuery {}

/**
 * Runtime binding for the `SetInstanceHealth` operation (IAM action
 * `autoscaling:SetInstanceHealth` scoped to the group ARN).
 *
 * Reports an instance's health to EC2 Auto Scaling — the backbone of custom
 * health checks: a watchdog Lambda (or the instance itself) flags an instance
 * `Unhealthy` and the group replaces it. Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.SetInstanceHealthHttp)`.
 * @binding
 * @section Custom Health Checks
 * @example Flag a failing instance for replacement
 * ```typescript
 * // init — bind the operation to the group
 * const setInstanceHealth = yield* AWS.AutoScaling.SetInstanceHealth(group);
 *
 * // runtime — mark the instance unhealthy so the group replaces it
 * yield* setInstanceHealth({
 *   InstanceId: instanceId,
 *   HealthStatus: "Unhealthy",
 * });
 * ```
 */
export interface SetInstanceHealth extends Binding.Service<
  SetInstanceHealth,
  "AWS.AutoScaling.SetInstanceHealth",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    (
      request: SetInstanceHealthRequest,
    ) => Effect.Effect<
      autoscaling.SetInstanceHealthResponse,
      autoscaling.SetInstanceHealthError
    >
  >
> {}

export const SetInstanceHealth = Binding.Service<SetInstanceHealth>(
  "AWS.AutoScaling.SetInstanceHealth",
);
