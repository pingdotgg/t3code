import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:DeleteKxScalingGroup` — deletes a scaling group from the bound environment. The group must have no clusters placed on it.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.DeleteKxScalingGroupHttp)`.
 * @binding
 * @section Managing Scaling Groups
 * @example Delete a Scaling Group
 * ```typescript
 * const deleteScalingGroup = yield* AWS.FinSpace.DeleteKxScalingGroup(kdb);
 *
 * yield* deleteScalingGroup({
 *   scalingGroupName: "shared-hosts",
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface DeleteKxScalingGroup extends Binding.Service<
  DeleteKxScalingGroup,
  "AWS.FinSpace.DeleteKxScalingGroup",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DeleteKxScalingGroupRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.DeleteKxScalingGroupResponse,
      SVC.DeleteKxScalingGroupError
    >
  >
> {}
export const DeleteKxScalingGroup = Binding.Service<DeleteKxScalingGroup>(
  "AWS.FinSpace.DeleteKxScalingGroup",
);
