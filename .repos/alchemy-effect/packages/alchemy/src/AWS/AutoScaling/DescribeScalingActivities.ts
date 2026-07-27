import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `DescribeScalingActivities` request with `AutoScalingGroupName` injected
 * from the bound {@link AutoScalingGroup}.
 */
export interface DescribeScalingActivitiesRequest extends Omit<
  autoscaling.DescribeScalingActivitiesType,
  "AutoScalingGroupName"
> {}

/**
 * Runtime binding for the `DescribeScalingActivities` operation (IAM action
 * `autoscaling:DescribeScalingActivities`; EC2 Auto Scaling `Describe*`
 * actions do not support resource-level permissions, so the grant is on `*`).
 *
 * Returns the bound group's recent scaling activities — what scaled, when,
 * why, and whether it succeeded. Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.DescribeScalingActivitiesHttp)`.
 * @binding
 * @section Observing Scaling Activity
 * @example List recent scaling activities
 * ```typescript
 * // init — bind the operation to the group
 * const describeScalingActivities =
 *   yield* AWS.AutoScaling.DescribeScalingActivities(group);
 *
 * // runtime — page through the group's recent activities
 * const page = yield* describeScalingActivities({ MaxRecords: 50 });
 * for (const activity of page.Activities ?? []) {
 *   yield* Effect.log(`${activity.StatusCode}: ${activity.Cause}`);
 * }
 * ```
 */
export interface DescribeScalingActivities extends Binding.Service<
  DescribeScalingActivities,
  "AWS.AutoScaling.DescribeScalingActivities",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    (
      request?: DescribeScalingActivitiesRequest,
    ) => Effect.Effect<
      autoscaling.ActivitiesType,
      autoscaling.DescribeScalingActivitiesError
    >
  >
> {}

export const DescribeScalingActivities =
  Binding.Service<DescribeScalingActivities>(
    "AWS.AutoScaling.DescribeScalingActivities",
  );
