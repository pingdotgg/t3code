import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface GetTaskProtectionRequest extends Omit<
  ECS.GetTaskProtectionRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:GetTaskProtection`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that reads the scale-in protection status of service-managed tasks
 * in the bound cluster. The cluster ARN is injected automatically and the
 * host is granted `ecs:GetTaskProtection` on the cluster's tasks.
 * @binding
 * @section Task Protection
 * @example Read a Task's Protection Status
 * ```typescript
 * const getTaskProtection = yield* AWS.ECS.GetTaskProtection(cluster);
 *
 * const response = yield* getTaskProtection({ tasks: [taskArn] });
 * const protected_ = response.protectedTasks?.[0]?.protectionEnabled;
 * ```
 */
export interface GetTaskProtection extends Binding.Service<
  GetTaskProtection,
  "AWS.ECS.GetTaskProtection",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: GetTaskProtectionRequest,
    ) => Effect.Effect<
      ECS.GetTaskProtectionResponse,
      ECS.GetTaskProtectionError
    >
  >
> {}
export const GetTaskProtection = Binding.Service<GetTaskProtection>(
  "AWS.ECS.GetTaskProtection",
);
