import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface ListTasksRequest extends Omit<
  ECS.ListTasksRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:ListTasks`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that lists task ARNs in the bound cluster. The cluster ARN is
 * injected automatically and the grant is conditioned on the bound cluster.
 * @binding
 * @section Listing Tasks
 * @example List Stopped Tasks
 * ```typescript
 * const listTasks = yield* AWS.ECS.ListTasks(cluster);
 *
 * const response = yield* listTasks({
 *   desiredStatus: "STOPPED",
 * });
 * const taskArns = response.taskArns ?? [];
 * ```
 */
export interface ListTasks extends Binding.Service<
  ListTasks,
  "AWS.ECS.ListTasks",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ListTasksRequest,
    ) => Effect.Effect<ECS.ListTasksResponse, ECS.ListTasksError>
  >
> {}
export const ListTasks = Binding.Service<ListTasks>("AWS.ECS.ListTasks");
