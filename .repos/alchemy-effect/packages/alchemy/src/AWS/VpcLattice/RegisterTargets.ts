import type * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * `RegisterTargets` request with `targetGroupIdentifier` injected from the
 * bound {@link TargetGroup}.
 */
export interface RegisterTargetsRequest extends Omit<
  vpclattice.RegisterTargetsRequest,
  "targetGroupIdentifier"
> {}

/**
 * Runtime binding for the `RegisterTargets` operation (IAM action
 * `vpc-lattice:RegisterTargets` on the target group ARN).
 *
 * Registers targets with the bound {@link TargetGroup} at runtime — the
 * self-registration data plane for workloads that join a lattice service
 * dynamically. Provide the implementation with
 * `Effect.provide(AWS.VpcLattice.RegisterTargetsHttp)`.
 * @binding
 * @section Managing Targets at Runtime
 * @example Register a target
 * ```typescript
 * const registerTargets = yield* AWS.VpcLattice.RegisterTargets(targetGroup);
 *
 * const { successful, unsuccessful } = yield* registerTargets({
 *   targets: [{ id: "10.0.1.10", port: 80 }],
 * });
 * ```
 */
export interface RegisterTargets extends Binding.Service<
  RegisterTargets,
  "AWS.VpcLattice.RegisterTargets",
  (
    targetGroup: TargetGroup,
  ) => Effect.Effect<
    (
      request: RegisterTargetsRequest,
    ) => Effect.Effect<
      vpclattice.RegisterTargetsResponse,
      vpclattice.RegisterTargetsError
    >
  >
> {}
export const RegisterTargets = Binding.Service<RegisterTargets>(
  "AWS.VpcLattice.RegisterTargets",
);
