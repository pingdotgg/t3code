import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface UpdateContainerInstancesStateRequest extends Omit<
  ECS.UpdateContainerInstancesStateRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:UpdateContainerInstancesState`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that transitions container instances between `ACTIVE` and
 * `DRAINING` — the canonical building block of an Auto Scaling
 * lifecycle-hook drain function that gracefully migrates tasks off an
 * instance before it terminates. The cluster ARN is injected automatically
 * and the host is granted `ecs:UpdateContainerInstancesState` on the
 * cluster's container instances.
 * @binding
 * @section Container Instances
 * @example Drain an Instance Before Termination
 * ```typescript
 * const updateContainerInstancesState =
 *   yield* AWS.ECS.UpdateContainerInstancesState(cluster);
 *
 * yield* updateContainerInstancesState({
 *   containerInstances: [containerInstanceArn],
 *   status: "DRAINING",
 * });
 * ```
 */
export interface UpdateContainerInstancesState extends Binding.Service<
  UpdateContainerInstancesState,
  "AWS.ECS.UpdateContainerInstancesState",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: UpdateContainerInstancesStateRequest,
    ) => Effect.Effect<
      ECS.UpdateContainerInstancesStateResponse,
      ECS.UpdateContainerInstancesStateError
    >
  >
> {}
export const UpdateContainerInstancesState =
  Binding.Service<UpdateContainerInstancesState>(
    "AWS.ECS.UpdateContainerInstancesState",
  );
