import type * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * `ListTargets` request with `targetGroupIdentifier` injected from the bound
 * {@link TargetGroup}.
 */
export interface ListTargetsRequest extends Omit<
  vpclattice.ListTargetsRequest,
  "targetGroupIdentifier"
> {}

/**
 * Runtime binding for the `ListTargets` operation (IAM action
 * `vpc-lattice:ListTargets` on the target group ARN).
 *
 * Lists the bound {@link TargetGroup}'s registered targets with their health
 * status — useful for health dashboards and for compute that verifies its own
 * registration. Provide the implementation with
 * `Effect.provide(AWS.VpcLattice.ListTargetsHttp)`.
 * @binding
 * @section Managing Targets at Runtime
 * @example List the target group's targets
 * ```typescript
 * const listTargets = yield* AWS.VpcLattice.ListTargets(targetGroup);
 *
 * const { items } = yield* listTargets({});
 * for (const target of items) {
 *   yield* Effect.log(`${target.id}: ${target.status}`);
 * }
 * ```
 */
export interface ListTargets extends Binding.Service<
  ListTargets,
  "AWS.VpcLattice.ListTargets",
  (
    targetGroup: TargetGroup,
  ) => Effect.Effect<
    (
      request: ListTargetsRequest,
    ) => Effect.Effect<
      vpclattice.ListTargetsResponse,
      vpclattice.ListTargetsError
    >
  >
> {}
export const ListTargets = Binding.Service<ListTargets>(
  "AWS.VpcLattice.ListTargets",
);
