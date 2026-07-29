import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeInsightsRefresh`.
 *
 * Reads the status of the bound cluster's insights refresh — whether an on-demand refresh (kicked off via {@link StartInsightsRefresh}) is in progress, completed, or failed.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeInsightsRefresh` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeInsightsRefreshHttp)`.
 * @binding
 * @section Cluster Insights
 * @example Check an Insights Refresh's Status
 * ```typescript
 * // init
 * const describeInsightsRefresh = yield* AWS.EKS.DescribeInsightsRefresh(cluster);
 *
 * // runtime
 * const { status } = yield* describeInsightsRefresh();
 * ```
 */
export interface DescribeInsightsRefresh extends Binding.Service<
  DescribeInsightsRefresh,
  "AWS.EKS.DescribeInsightsRefresh",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.DescribeInsightsRefreshRequest, "clusterName">,
    ) => Effect.Effect<
      eks.DescribeInsightsRefreshResponse,
      eks.DescribeInsightsRefreshError
    >
  >
> {}
export const DescribeInsightsRefresh = Binding.Service<DescribeInsightsRefresh>(
  "AWS.EKS.DescribeInsightsRefresh",
);
