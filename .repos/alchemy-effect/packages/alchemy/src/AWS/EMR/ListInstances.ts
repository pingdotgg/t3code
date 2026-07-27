import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListInstances` — lists the bound cluster's EC2 instances with state, private/public addresses, and group/fleet membership.
 * @binding
 * @section Inspecting the Cluster
 * @example List Running Core Instances
 * ```typescript
 * const listInstances = yield* AWS.EMR.ListInstances(cluster);
 *
 * const { Instances } = yield* listInstances({
 *   InstanceGroupTypes: ["CORE"],
 *   InstanceStates: ["RUNNING"],
 * });
 * ```
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "AWS.EMR.ListInstances",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListInstancesInput, "ClusterId">,
    ) => Effect.Effect<SVC.ListInstancesOutput, SVC.ListInstancesError>
  >
> {}
export const ListInstances = Binding.Service<ListInstances>(
  "AWS.EMR.ListInstances",
);
