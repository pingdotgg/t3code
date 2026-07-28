import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * `RegisterTargets` request with `TargetGroupArn` injected from the bound
 * {@link TargetGroup}.
 */
export interface RegisterTargetsRequest extends Omit<
  elbv2.RegisterTargetsInput,
  "TargetGroupArn"
> {}

/**
 * Runtime binding for the `RegisterTargets` operation (IAM action
 * `elasticloadbalancing:RegisterTargets` scoped to the target-group ARN).
 *
 * Registers targets (instances, IPs, Lambda functions, or an ALB) with the
 * bound target group at runtime — e.g. custom blue/green orchestration, or
 * compute that registers itself into a target group at boot.
 * Provide the implementation with
 * `Effect.provide(AWS.ELBv2.RegisterTargetsHttp)`.
 * @binding
 * @section Dynamic Target Management
 * @example Register an IP target
 * ```typescript
 * // init — bind the operation to the target group
 * const registerTargets = yield* AWS.ELBv2.RegisterTargets(targetGroup);
 *
 * // runtime — register a target by IP and port
 * yield* registerTargets({
 *   Targets: [{ Id: "10.0.1.15", Port: 8080 }],
 * });
 * ```
 */
export interface RegisterTargets extends Binding.Service<
  RegisterTargets,
  "AWS.ELBv2.RegisterTargets",
  (
    targetGroup: TargetGroup,
  ) => Effect.Effect<
    (
      request: RegisterTargetsRequest,
    ) => Effect.Effect<elbv2.RegisterTargetsOutput, elbv2.RegisterTargetsError>
  >
> {}

export const RegisterTargets = Binding.Service<RegisterTargets>(
  "AWS.ELBv2.RegisterTargets",
);
