import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * `DeregisterTargets` request with `TargetGroupArn` injected from the bound
 * {@link TargetGroup}.
 */
export interface DeregisterTargetsRequest extends Omit<
  elbv2.DeregisterTargetsInput,
  "TargetGroupArn"
> {}

/**
 * Runtime binding for the `DeregisterTargets` operation (IAM action
 * `elasticloadbalancing:DeregisterTargets` scoped to the target-group ARN).
 *
 * Deregisters targets from the bound target group at runtime — the target
 * enters `draining` and is removed once in-flight requests complete. Pairs
 * with {@link RegisterTargets} for custom blue/green orchestration or
 * graceful self-removal on shutdown.
 * Provide the implementation with
 * `Effect.provide(AWS.ELBv2.DeregisterTargetsHttp)`.
 * @binding
 * @section Dynamic Target Management
 * @example Drain an IP target
 * ```typescript
 * // init — bind the operation to the target group
 * const deregisterTargets = yield* AWS.ELBv2.DeregisterTargets(targetGroup);
 *
 * // runtime — start draining the target
 * yield* deregisterTargets({
 *   Targets: [{ Id: "10.0.1.15", Port: 8080 }],
 * });
 * ```
 */
export interface DeregisterTargets extends Binding.Service<
  DeregisterTargets,
  "AWS.ELBv2.DeregisterTargets",
  (
    targetGroup: TargetGroup,
  ) => Effect.Effect<
    (
      request: DeregisterTargetsRequest,
    ) => Effect.Effect<
      elbv2.DeregisterTargetsOutput,
      elbv2.DeregisterTargetsError
    >
  >
> {}

export const DeregisterTargets = Binding.Service<DeregisterTargets>(
  "AWS.ELBv2.DeregisterTargets",
);
