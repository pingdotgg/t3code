import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:AddInstanceFleet` — adds a task instance fleet to the bound cluster (instance-fleet clusters only; TASK fleets can be added after launch).
 * ### Scaling the Cluster
 * **Example:** Add a Task Fleet
 * ```typescript
 * const addFleet = yield* AWS.EMR.AddInstanceFleet(cluster);
 *
 * const { InstanceFleetId } = yield* addFleet({
 *   InstanceFleet: {
 *     InstanceFleetType: "TASK",
 *     TargetSpotCapacity: 2,
 *     InstanceTypeConfigs: [{ InstanceType: "m5.xlarge" }],
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface AddInstanceFleet extends Binding.Service<
  AddInstanceFleet,
  "AWS.EMR.AddInstanceFleet",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.AddInstanceFleetInput, "ClusterId">,
    ) => Effect.Effect<SVC.AddInstanceFleetOutput, SVC.AddInstanceFleetError>
  >
> {}
export const AddInstanceFleet = Binding.Service<AddInstanceFleet>(
  "AWS.EMR.AddInstanceFleet",
);
