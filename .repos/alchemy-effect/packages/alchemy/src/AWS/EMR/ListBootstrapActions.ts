import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListBootstrapActions` — lists the bootstrap actions the bound cluster ran at launch.
 * ### Inspecting the Cluster
 * **Example:** List Bootstrap Actions
 * ```typescript
 * const listBootstrapActions = yield* AWS.EMR.ListBootstrapActions(cluster);
 *
 * const { BootstrapActions } = yield* listBootstrapActions();
 * ```
 *
 * @binding
 */
export interface ListBootstrapActions extends Binding.Service<
  ListBootstrapActions,
  "AWS.EMR.ListBootstrapActions",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListBootstrapActionsInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.ListBootstrapActionsOutput,
      SVC.ListBootstrapActionsError
    >
  >
> {}
export const ListBootstrapActions = Binding.Service<ListBootstrapActions>(
  "AWS.EMR.ListBootstrapActions",
);
