import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:DescribeInsight`.
 *
 * Reads one insight's full detail — category, status, recommendation, and the resources it flags.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeInsight` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeInsightHttp)`.
 * @binding
 * @section Cluster Insights
 * @example Read an Insight's Recommendation
 * ```typescript
 * // init
 * const describeInsight = yield* AWS.EKS.DescribeInsight(cluster);
 *
 * // runtime
 * const { insight } = yield* describeInsight({ id: insightId });
 * ```
 */
export interface DescribeInsight extends Binding.Service<
  DescribeInsight,
  "AWS.EKS.DescribeInsight",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<eks.DescribeInsightRequest, "clusterName">,
    ) => Effect.Effect<eks.DescribeInsightResponse, eks.DescribeInsightError>
  >
> {}
export const DescribeInsight = Binding.Service<DescribeInsight>(
  "AWS.EKS.DescribeInsight",
);
