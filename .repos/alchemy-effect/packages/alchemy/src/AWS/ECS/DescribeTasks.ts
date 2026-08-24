import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface DescribeTasksRequest extends Omit<
  ECS.DescribeTasksRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:DescribeTasks`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that describes tasks in the bound cluster. The cluster ARN is
 * injected automatically and the host is granted `ecs:DescribeTasks` on the
 * cluster's tasks.
 * @binding
 * @section Describing Tasks
 * @example Poll a Task Until It Stops
 * ```typescript
 * const describeTasks = yield* AWS.ECS.DescribeTasks(cluster);
 *
 * const response = yield* describeTasks({ tasks: [taskArn] });
 * const status = response.tasks?.[0]?.lastStatus;
 * const exitCode = response.tasks?.[0]?.containers?.[0]?.exitCode;
 * ```
 */
export interface DescribeTasks extends Binding.Service<
  DescribeTasks,
  "AWS.ECS.DescribeTasks",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: DescribeTasksRequest,
    ) => Effect.Effect<ECS.DescribeTasksResponse, ECS.DescribeTasksError>
  >
> {}
export const DescribeTasks = Binding.Service<DescribeTasks>(
  "AWS.ECS.DescribeTasks",
);
