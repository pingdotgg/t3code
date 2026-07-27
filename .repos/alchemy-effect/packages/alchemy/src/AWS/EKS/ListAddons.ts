import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListAddons`.
 *
 * Enumerates the add-on names installed on the bound cluster.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListAddons` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListAddonsHttp)`.
 * @binding
 * @section Inspecting Add-ons
 * @example List Installed Add-ons
 * ```typescript
 * // init
 * const listAddons = yield* AWS.EKS.ListAddons(cluster);
 *
 * // runtime
 * const { addons } = yield* listAddons();
 * ```
 */
export interface ListAddons extends Binding.Service<
  ListAddons,
  "AWS.EKS.ListAddons",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListAddonsRequest, "clusterName">,
    ) => Effect.Effect<eks.ListAddonsResponse, eks.ListAddonsError>
  >
> {}
export const ListAddons = Binding.Service<ListAddons>("AWS.EKS.ListAddons");
