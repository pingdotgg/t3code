import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:AddInstanceGroups` — adds task instance groups to the bound cluster (instance-group clusters only). The cluster id is injected as `JobFlowId`.
 * @binding
 * @section Scaling the Cluster
 * @example Add a Task Group
 * ```typescript
 * const addGroups = yield* AWS.EMR.AddInstanceGroups(cluster);
 *
 * const { InstanceGroupIds } = yield* addGroups({
 *   InstanceGroups: [{
 *     InstanceRole: "TASK",
 *     InstanceType: "m5.xlarge",
 *     InstanceCount: 2,
 *   }],
 * });
 * ```
 */
export interface AddInstanceGroups extends Binding.Service<
  AddInstanceGroups,
  "AWS.EMR.AddInstanceGroups",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.AddInstanceGroupsInput, "JobFlowId">,
    ) => Effect.Effect<SVC.AddInstanceGroupsOutput, SVC.AddInstanceGroupsError>
  >
> {}
export const AddInstanceGroups = Binding.Service<AddInstanceGroups>(
  "AWS.EMR.AddInstanceGroups",
);
