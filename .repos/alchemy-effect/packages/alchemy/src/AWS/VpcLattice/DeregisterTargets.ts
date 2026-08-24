import type * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * `DeregisterTargets` request with `targetGroupIdentifier` injected from the
 * bound {@link TargetGroup}.
 */
export interface DeregisterTargetsRequest extends Omit<
  vpclattice.DeregisterTargetsRequest,
  "targetGroupIdentifier"
> {}

/**
 * Runtime binding for the `DeregisterTargets` operation (IAM action
 * `vpc-lattice:DeregisterTargets` on the target group ARN).
 *
 * Deregisters targets from the bound {@link TargetGroup} at runtime — the
 * graceful-drain half of dynamic self-registration. Provide the
 * implementation with `Effect.provide(AWS.VpcLattice.DeregisterTargetsHttp)`.
 * @binding
 * @section Managing Targets at Runtime
 * @example Deregister a target
 * ```typescript
 * const deregisterTargets = yield* AWS.VpcLattice.DeregisterTargets(targetGroup);
 *
 * yield* deregisterTargets({ targets: [{ id: "10.0.1.10", port: 80 }] });
 * ```
 */
export interface DeregisterTargets extends Binding.Service<
  DeregisterTargets,
  "AWS.VpcLattice.DeregisterTargets",
  (
    targetGroup: TargetGroup,
  ) => Effect.Effect<
    (
      request: DeregisterTargetsRequest,
    ) => Effect.Effect<
      vpclattice.DeregisterTargetsResponse,
      vpclattice.DeregisterTargetsError
    >
  >
> {}
export const DeregisterTargets = Binding.Service<DeregisterTargets>(
  "AWS.VpcLattice.DeregisterTargets",
);
