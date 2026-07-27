import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ModifyInstanceGroups` — resizes or reconfigures the bound cluster's instance groups (target counts, EC2 configurations, shrink policies).
 * @binding
 * @section Scaling the Cluster
 * @example Resize the Core Group
 * ```typescript
 * const modifyGroups = yield* AWS.EMR.ModifyInstanceGroups(cluster);
 *
 * yield* modifyGroups({
 *   InstanceGroups: [{ InstanceGroupId: coreGroupId, InstanceCount: 3 }],
 * });
 * ```
 */
export interface ModifyInstanceGroups extends Binding.Service<
  ModifyInstanceGroups,
  "AWS.EMR.ModifyInstanceGroups",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ModifyInstanceGroupsInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.ModifyInstanceGroupsResponse,
      SVC.ModifyInstanceGroupsError
    >
  >
> {}
export const ModifyInstanceGroups = Binding.Service<ModifyInstanceGroups>(
  "AWS.EMR.ModifyInstanceGroups",
);
