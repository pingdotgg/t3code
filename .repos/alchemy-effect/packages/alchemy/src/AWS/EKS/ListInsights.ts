import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListInsights`.
 *
 * Enumerates EKS upgrade/configuration insights for the bound cluster — findings that block or degrade a Kubernetes version upgrade.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListInsights` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListInsightsHttp)`.
 * @binding
 * @section Cluster Insights
 * @example List Upgrade-Blocking Insights
 * ```typescript
 * // init
 * const listInsights = yield* AWS.EKS.ListInsights(cluster);
 *
 * // runtime
 * const { insights } = yield* listInsights({
 *   filter: { statuses: ["ERROR", "WARNING"] },
 * });
 * ```
 */
export interface ListInsights extends Binding.Service<
  ListInsights,
  "AWS.EKS.ListInsights",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListInsightsRequest, "clusterName">,
    ) => Effect.Effect<eks.ListInsightsResponse, eks.ListInsightsError>
  >
> {}
export const ListInsights = Binding.Service<ListInsights>(
  "AWS.EKS.ListInsights",
);
