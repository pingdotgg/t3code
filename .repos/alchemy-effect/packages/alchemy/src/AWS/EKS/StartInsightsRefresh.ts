import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:StartInsightsRefresh`.
 *
 * Kicks off an on-demand refresh of the bound cluster's upgrade/configuration insights instead of waiting for the periodic automatic evaluation. Track progress with {@link DescribeInsightsRefresh}.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:StartInsightsRefresh` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.StartInsightsRefreshHttp)`.
 * @binding
 * @section Cluster Insights
 * @example Refresh Insights Before an Upgrade Check
 * ```typescript
 * // init
 * const startInsightsRefresh = yield* AWS.EKS.StartInsightsRefresh(cluster);
 *
 * // runtime
 * const { status } = yield* startInsightsRefresh();
 * ```
 */
export interface StartInsightsRefresh extends Binding.Service<
  StartInsightsRefresh,
  "AWS.EKS.StartInsightsRefresh",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.StartInsightsRefreshRequest, "clusterName">,
    ) => Effect.Effect<
      eks.StartInsightsRefreshResponse,
      eks.StartInsightsRefreshError
    >
  >
> {}
export const StartInsightsRefresh = Binding.Service<StartInsightsRefresh>(
  "AWS.EKS.StartInsightsRefresh",
);
