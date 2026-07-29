import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface DescribeContainerInstancesRequest extends Omit<
  ECS.DescribeContainerInstancesRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:DescribeContainerInstances`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that describes container instances registered to the bound
 * cluster — remaining resources, running-task counts, agent status. The
 * cluster ARN is injected automatically and the host is granted
 * `ecs:DescribeContainerInstances` on the cluster's container instances.
 * @binding
 * @section Container Instances
 * @example Inspect Remaining Capacity
 * ```typescript
 * const describeContainerInstances =
 *   yield* AWS.ECS.DescribeContainerInstances(cluster);
 *
 * const response = yield* describeContainerInstances({
 *   containerInstances: [containerInstanceArn],
 * });
 * const remaining = response.containerInstances?.[0]?.remainingResources;
 * ```
 */
export interface DescribeContainerInstances extends Binding.Service<
  DescribeContainerInstances,
  "AWS.ECS.DescribeContainerInstances",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: DescribeContainerInstancesRequest,
    ) => Effect.Effect<
      ECS.DescribeContainerInstancesResponse,
      ECS.DescribeContainerInstancesError
    >
  >
> {}
export const DescribeContainerInstances =
  Binding.Service<DescribeContainerInstances>(
    "AWS.ECS.DescribeContainerInstances",
  );
