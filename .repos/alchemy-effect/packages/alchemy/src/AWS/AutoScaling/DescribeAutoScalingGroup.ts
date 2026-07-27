import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * Runtime binding for the `DescribeAutoScalingGroups` operation scoped to one
 * group (IAM action `autoscaling:DescribeAutoScalingGroups`; EC2 Auto Scaling
 * `Describe*` actions do not support resource-level permissions, so the grant
 * is on `*`).
 *
 * Returns the bound group's live description — capacity, instances and their
 * lifecycle states, suspended processes — or `undefined` if the group no
 * longer exists. Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.DescribeAutoScalingGroupHttp)`.
 * @binding
 * @section Observing the Fleet
 * @example Inspect live capacity and instances
 * ```typescript
 * // init — bind the operation to the group
 * const describeGroup = yield* AWS.AutoScaling.DescribeAutoScalingGroup(group);
 *
 * // runtime — read the group's live state
 * const live = yield* describeGroup();
 * const inService = (live?.Instances ?? []).filter(
 *   (i) => i.LifecycleState === "InService",
 * );
 * ```
 */
export interface DescribeAutoScalingGroup extends Binding.Service<
  DescribeAutoScalingGroup,
  "AWS.AutoScaling.DescribeAutoScalingGroup",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      autoscaling.AutoScalingGroup | undefined,
      autoscaling.DescribeAutoScalingGroupsError
    >
  >
> {}

export const DescribeAutoScalingGroup =
  Binding.Service<DescribeAutoScalingGroup>(
    "AWS.AutoScaling.DescribeAutoScalingGroup",
  );
