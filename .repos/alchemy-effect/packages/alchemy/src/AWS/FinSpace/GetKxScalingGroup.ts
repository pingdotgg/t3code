import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxScalingGroup` — reads a scaling group's status, host type, and the clusters placed on it in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxScalingGroupHttp)`.
 * @binding
 * @section Managing Scaling Groups
 * @example Poll a Scaling Group to Active
 * ```typescript
 * const getScalingGroup = yield* AWS.FinSpace.GetKxScalingGroup(kdb);
 *
 * const group = yield* getScalingGroup({ scalingGroupName: "shared-hosts" });
 * if (group.status === "ACTIVE") {
 *   yield* Effect.log(`clusters: ${group.clusters?.join(", ")}`);
 * }
 * ```
 */
export interface GetKxScalingGroup extends Binding.Service<
  GetKxScalingGroup,
  "AWS.FinSpace.GetKxScalingGroup",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxScalingGroupRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.GetKxScalingGroupResponse,
      SVC.GetKxScalingGroupError
    >
  >
> {}
export const GetKxScalingGroup = Binding.Service<GetKxScalingGroup>(
  "AWS.FinSpace.GetKxScalingGroup",
);
