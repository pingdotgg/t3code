import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ModifyInstanceFleet` — retargets the bound cluster's instance fleet (on-demand/spot capacities, resize specifications).
 * @binding
 * @section Scaling the Cluster
 * @example Retarget a Fleet
 * ```typescript
 * const modifyFleet = yield* AWS.EMR.ModifyInstanceFleet(cluster);
 *
 * yield* modifyFleet({
 *   InstanceFleet: {
 *     InstanceFleetId: fleetId,
 *     TargetOnDemandCapacity: 4,
 *   },
 * });
 * ```
 */
export interface ModifyInstanceFleet extends Binding.Service<
  ModifyInstanceFleet,
  "AWS.EMR.ModifyInstanceFleet",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ModifyInstanceFleetInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.ModifyInstanceFleetResponse,
      SVC.ModifyInstanceFleetError
    >
  >
> {}
export const ModifyInstanceFleet = Binding.Service<ModifyInstanceFleet>(
  "AWS.EMR.ModifyInstanceFleet",
);
