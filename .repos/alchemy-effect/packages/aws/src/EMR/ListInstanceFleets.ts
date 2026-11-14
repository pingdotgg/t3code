import type * as SVC from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListInstanceFleets` — lists the bound cluster's instance fleets (instance-fleet clusters only) with target and provisioned capacities.
 * ### Inspecting the Cluster
 * **Example:** Read Fleet Capacities
 * ```typescript
 * const listInstanceFleets = yield* AWS.EMR.ListInstanceFleets(cluster);
 *
 * const { InstanceFleets } = yield* listInstanceFleets();
 * ```
 *
 * @binding
 */
export interface ListInstanceFleets extends Binding.Service<
  ListInstanceFleets,
  "AWS.EMR.ListInstanceFleets",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListInstanceFleetsInput, "ClusterId">,
    ) => Effect.Effect<SVC.ListInstanceFleetsOutput, SVC.ListInstanceFleetsError>
  >
> {}
export const ListInstanceFleets = Binding.Service<ListInstanceFleets>("AWS.EMR.ListInstanceFleets");
