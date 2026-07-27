import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `StartInstanceRefresh` request with `AutoScalingGroupName` injected from
 * the bound {@link AutoScalingGroup}.
 */
export interface StartInstanceRefreshRequest extends Omit<
  autoscaling.StartInstanceRefreshType,
  "AutoScalingGroupName"
> {}

/**
 * `CancelInstanceRefresh` request with `AutoScalingGroupName` injected from
 * the bound {@link AutoScalingGroup}.
 */
export interface CancelInstanceRefreshRequest extends Omit<
  autoscaling.CancelInstanceRefreshType,
  "AutoScalingGroupName"
> {}

/**
 * `DescribeInstanceRefreshes` request with `AutoScalingGroupName` injected
 * from the bound {@link AutoScalingGroup}.
 */
export interface DescribeInstanceRefreshesRequest extends Omit<
  autoscaling.DescribeInstanceRefreshesType,
  "AutoScalingGroupName"
> {}

export interface InstanceRefreshClient {
  /**
   * Begin rolling the group's instances onto the current launch template (or
   * the supplied `DesiredConfiguration`). Returns the refresh id to track.
   */
  start: (
    request?: StartInstanceRefreshRequest,
  ) => Effect.Effect<
    autoscaling.StartInstanceRefreshAnswer,
    autoscaling.StartInstanceRefreshError
  >;
  /**
   * Cancel the in-progress refresh. Instances already replaced are not rolled
   * back — use `rollback` for that.
   */
  cancel: (
    request?: CancelInstanceRefreshRequest,
  ) => Effect.Effect<
    autoscaling.CancelInstanceRefreshAnswer,
    autoscaling.CancelInstanceRefreshError
  >;
  /**
   * Roll the group back to the configuration it had before the in-progress
   * refresh started.
   */
  rollback: () => Effect.Effect<
    autoscaling.RollbackInstanceRefreshAnswer,
    autoscaling.RollbackInstanceRefreshError
  >;
  /**
   * Page through the group's instance refreshes (newest first), including
   * per-refresh status and progress details.
   */
  describe: (
    request?: DescribeInstanceRefreshesRequest,
  ) => Effect.Effect<
    autoscaling.DescribeInstanceRefreshesAnswer,
    autoscaling.DescribeInstanceRefreshesError
  >;
}

/**
 * Runtime binding for the instance refresh operations — `StartInstanceRefresh`,
 * `CancelInstanceRefresh`, `RollbackInstanceRefresh` (IAM actions scoped to
 * the group ARN) and `DescribeInstanceRefreshes` (granted on `*`; EC2 Auto
 * Scaling `Describe*` actions do not support resource-level permissions).
 *
 * Lets a deploy pipeline Lambda roll the fleet onto a new launch template
 * version, watch progress, and cancel or roll back a bad deploy. Provide the
 * implementation with `Effect.provide(AWS.AutoScaling.InstanceRefreshHttp)`.
 * @binding
 * @section Rolling Deployments
 * @example Roll the fleet and watch progress
 * ```typescript
 * // init — bind the operations to the group
 * const refresh = yield* AWS.AutoScaling.InstanceRefresh(group);
 *
 * // runtime — start a rolling replacement with auto-rollback
 * const { InstanceRefreshId } = yield* refresh.start({
 *   Preferences: { MinHealthyPercentage: 90, AutoRollback: true },
 * });
 *
 * // runtime — check on it
 * const page = yield* refresh.describe({
 *   InstanceRefreshIds: [InstanceRefreshId!],
 * });
 * ```
 *
 * @example Cancel a bad deploy
 * ```typescript
 * yield* refresh.cancel().pipe(
 *   Effect.catchTag("ActiveInstanceRefreshNotFoundFault", () => Effect.void),
 * );
 * ```
 */
export interface InstanceRefresh extends Binding.Service<
  InstanceRefresh,
  "AWS.AutoScaling.InstanceRefresh",
  (group: AutoScalingGroup) => Effect.Effect<InstanceRefreshClient>
> {}

export const InstanceRefresh = Binding.Service<InstanceRefresh>(
  "AWS.AutoScaling.InstanceRefresh",
);
