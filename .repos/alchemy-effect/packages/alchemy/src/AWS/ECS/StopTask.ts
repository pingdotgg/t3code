import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface StopTaskRequest extends Omit<ECS.StopTaskRequest, "cluster"> {}

/**
 * Runtime binding for `ecs:StopTask`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that stops a running task in the bound cluster. The cluster ARN is
 * injected automatically and the host is granted `ecs:StopTask` on the
 * cluster's tasks.
 * @binding
 * @section Stopping Tasks
 * @example Stop a Running Task
 * ```typescript
 * const stopTask = yield* AWS.ECS.StopTask(cluster);
 *
 * const response = yield* stopTask({
 *   task: taskArn,
 *   reason: "drained by worker",
 * });
 * ```
 */
export interface StopTask extends Binding.Service<
  StopTask,
  "AWS.ECS.StopTask",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: StopTaskRequest,
    ) => Effect.Effect<ECS.StopTaskResponse, ECS.StopTaskError>
  >
> {}
export const StopTask = Binding.Service<StopTask>("AWS.ECS.StopTask");
