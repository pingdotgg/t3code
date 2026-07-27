import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListInstanceGroups` — lists the bound cluster's instance groups (instance-group clusters only) with requested/running counts — the ids feed {@link ModifyInstanceGroups} and {@link PutAutoScalingPolicy}.
 * @binding
 * @section Inspecting the Cluster
 * @example Find the Core Group
 * ```typescript
 * const listInstanceGroups = yield* AWS.EMR.ListInstanceGroups(cluster);
 *
 * const { InstanceGroups } = yield* listInstanceGroups();
 * const core = InstanceGroups?.find(
 *   (group) => group.InstanceGroupType === "CORE",
 * );
 * ```
 */
export interface ListInstanceGroups extends Binding.Service<
  ListInstanceGroups,
  "AWS.EMR.ListInstanceGroups",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListInstanceGroupsInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.ListInstanceGroupsOutput,
      SVC.ListInstanceGroupsError
    >
  >
> {}
export const ListInstanceGroups = Binding.Service<ListInstanceGroups>(
  "AWS.EMR.ListInstanceGroups",
);
