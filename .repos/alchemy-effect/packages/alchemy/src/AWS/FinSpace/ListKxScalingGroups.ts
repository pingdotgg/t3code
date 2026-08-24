import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxScalingGroups` — lists the scaling groups of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxScalingGroupsHttp)`.
 * @binding
 * @section Managing Scaling Groups
 * @example List Scaling Groups
 * ```typescript
 * const listScalingGroups = yield* AWS.FinSpace.ListKxScalingGroups(kdb);
 *
 * const { scalingGroups } = yield* listScalingGroups();
 * ```
 */
export interface ListKxScalingGroups extends Binding.Service<
  ListKxScalingGroups,
  "AWS.FinSpace.ListKxScalingGroups",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxScalingGroupsRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.ListKxScalingGroupsResponse,
      SVC.ListKxScalingGroupsError
    >
  >
> {}
export const ListKxScalingGroups = Binding.Service<ListKxScalingGroups>(
  "AWS.FinSpace.ListKxScalingGroups",
);
