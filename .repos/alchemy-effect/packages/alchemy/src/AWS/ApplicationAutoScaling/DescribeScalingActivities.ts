import type * as aas from "@distilled.cloud/aws/application-auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ScalableTarget } from "./ScalableTarget.ts";

/**
 * `DescribeScalingActivities` request with the scalable target's identity
 * triple (`ServiceNamespace`/`ResourceId`/`ScalableDimension`) injected from
 * the bound {@link ScalableTarget}.
 */
export interface DescribeScalingActivitiesRequest extends Omit<
  aas.DescribeScalingActivitiesRequest,
  "ServiceNamespace" | "ResourceId" | "ScalableDimension"
> {}

/**
 * Runtime binding for the `DescribeScalingActivities` operation (IAM action
 * `application-autoscaling:DescribeScalingActivities`).
 *
 * Returns the scalable target's scaling activities from the previous six
 * weeks — what scaled, when, why, and whether it succeeded — including
 * not-scaled reasons when `IncludeNotScaledActivities` is set. Provide the
 * implementation with
 * `Effect.provide(AWS.ApplicationAutoScaling.DescribeScalingActivitiesHttp)`.
 * @binding
 * @section Observing Scaling Activity
 * @example List Recent Scaling Activities
 * ```typescript
 * // init — bind the operation to the scalable target
 * const describeScalingActivities =
 *   yield* AWS.ApplicationAutoScaling.DescribeScalingActivities(target);
 *
 * // runtime — page through the target's recent activities
 * const page = yield* describeScalingActivities({ MaxResults: 50 });
 * for (const activity of page.ScalingActivities ?? []) {
 *   yield* Effect.log(`${activity.StatusCode}: ${activity.Description}`);
 * }
 * ```
 *
 * @example Include Not-Scaled Reasons
 * ```typescript
 * const page = yield* describeScalingActivities({
 *   IncludeNotScaledActivities: true,
 * });
 * ```
 */
export interface DescribeScalingActivities extends Binding.Service<
  DescribeScalingActivities,
  "AWS.ApplicationAutoScaling.DescribeScalingActivities",
  (
    target: ScalableTarget,
  ) => Effect.Effect<
    (
      request?: DescribeScalingActivitiesRequest,
    ) => Effect.Effect<
      aas.DescribeScalingActivitiesResponse,
      aas.DescribeScalingActivitiesError
    >
  >
> {}

export const DescribeScalingActivities =
  Binding.Service<DescribeScalingActivities>(
    "AWS.ApplicationAutoScaling.DescribeScalingActivities",
  );
