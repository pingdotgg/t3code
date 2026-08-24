import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * `DescribeTargetHealth` request with `TargetGroupArn` injected from the
 * bound {@link TargetGroup}.
 */
export interface DescribeTargetHealthRequest extends Omit<
  elbv2.DescribeTargetHealthInput,
  "TargetGroupArn"
> {}

/**
 * Runtime binding for the `DescribeTargetHealth` operation (IAM action
 * `elasticloadbalancing:DescribeTargetHealth`; ELBv2 `Describe*` actions do
 * not support resource-level permissions, so the grant is on `*`).
 *
 * Reads the live health state of the bound target group's targets — e.g. a
 * readiness gate that waits for a freshly registered target to turn
 * `healthy` before shifting traffic, or an ops endpoint surfacing fleet
 * health. Provide the implementation with
 * `Effect.provide(AWS.ELBv2.DescribeTargetHealthHttp)`.
 * @binding
 * @section Target Health
 * @example Check the health of every target
 * ```typescript
 * // init — bind the operation to the target group
 * const describeTargetHealth = yield* AWS.ELBv2.DescribeTargetHealth(targetGroup);
 *
 * // runtime — read health states
 * const health = yield* describeTargetHealth({});
 * const states = health.TargetHealthDescriptions?.map(
 *   (d) => d.TargetHealth?.State,
 * );
 * ```
 */
export interface DescribeTargetHealth extends Binding.Service<
  DescribeTargetHealth,
  "AWS.ELBv2.DescribeTargetHealth",
  (
    targetGroup: TargetGroup,
  ) => Effect.Effect<
    (
      request: DescribeTargetHealthRequest,
    ) => Effect.Effect<
      elbv2.DescribeTargetHealthOutput,
      elbv2.DescribeTargetHealthError
    >
  >
> {}

export const DescribeTargetHealth = Binding.Service<DescribeTargetHealth>(
  "AWS.ELBv2.DescribeTargetHealth",
);
