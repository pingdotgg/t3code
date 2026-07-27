import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface ListContainerInstancesRequest extends Omit<
  ECS.ListContainerInstancesRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:ListContainerInstances`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that lists container-instance ARNs registered to the bound
 * cluster (EC2/EXTERNAL launch types). The cluster ARN is injected
 * automatically and the host is granted `ecs:ListContainerInstances` on the
 * cluster.
 * @binding
 * @section Container Instances
 * @example List ACTIVE Container Instances
 * ```typescript
 * const listContainerInstances = yield* AWS.ECS.ListContainerInstances(cluster);
 *
 * const response = yield* listContainerInstances({ status: "ACTIVE" });
 * const instanceArns = response.containerInstanceArns ?? [];
 * ```
 */
export interface ListContainerInstances extends Binding.Service<
  ListContainerInstances,
  "AWS.ECS.ListContainerInstances",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ListContainerInstancesRequest,
    ) => Effect.Effect<
      ECS.ListContainerInstancesResponse,
      ECS.ListContainerInstancesError
    >
  >
> {}
export const ListContainerInstances = Binding.Service<ListContainerInstances>(
  "AWS.ECS.ListContainerInstances",
);
