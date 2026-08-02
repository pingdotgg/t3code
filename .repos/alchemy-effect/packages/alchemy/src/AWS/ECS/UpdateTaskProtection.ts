import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface UpdateTaskProtectionRequest extends Omit<
  ECS.UpdateTaskProtectionRequest,
  "cluster" | "expiresInMinutes"
> {
  /**
   * How long the protection should last, e.g. `"20 minutes"` or
   * `Duration.hours(1)`. Rounded to whole minutes on the wire
   * (1 minute – 48 hours).
   * @default "2 hours"
   */
  expiresIn?: Duration.Input;
}

/**
 * Runtime binding for `ecs:UpdateTaskProtection`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that toggles scale-in protection on service-managed tasks in the
 * bound cluster — the canonical pattern is a task protecting *itself* while
 * it processes long-running work so deployments and scale-in don't terminate
 * it. The cluster ARN is injected automatically and the host is granted
 * `ecs:UpdateTaskProtection` on the cluster's tasks.
 * @binding
 * @section Task Protection
 * @example Protect a Task While It Works
 * ```typescript
 * const updateTaskProtection = yield* AWS.ECS.UpdateTaskProtection(cluster);
 *
 * yield* updateTaskProtection({
 *   tasks: [taskArn],
 *   protectionEnabled: true,
 *   expiresIn: "30 minutes",
 * });
 * ```
 */
export interface UpdateTaskProtection extends Binding.Service<
  UpdateTaskProtection,
  "AWS.ECS.UpdateTaskProtection",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: UpdateTaskProtectionRequest,
    ) => Effect.Effect<
      ECS.UpdateTaskProtectionResponse,
      ECS.UpdateTaskProtectionError
    >
  >
> {}
export const UpdateTaskProtection = Binding.Service<UpdateTaskProtection>(
  "AWS.ECS.UpdateTaskProtection",
);
