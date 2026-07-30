import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetMetricStatisticsRequest
  extends cloudwatch.GetMetricStatisticsInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricStatistics` — fetch aggregated
 * datapoints for a single metric (the older single-metric query API;
 * prefer {@link GetMetricData} for metric math or multi-metric queries).
 *
 * Provide `CloudWatch.GetMetricStatisticsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Querying Metrics
 * @example Fetch Hourly Sums for a Metric
 * ```typescript
 * // init — grants cloudwatch:GetMetricStatistics
 * const getMetricStatistics = yield* AWS.CloudWatch.GetMetricStatistics();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const result = yield* getMetricStatistics({
 *   Namespace: "MyApp/Payments",
 *   MetricName: "PaymentProcessed",
 *   StartTime: new Date(now - 3_600_000),
 *   EndTime: new Date(now),
 *   Period: 60,
 *   Statistics: ["Sum"],
 * });
 * const datapoints = result.Datapoints ?? [];
 * ```
 */
export interface GetMetricStatistics extends Binding.Service<
  GetMetricStatistics,
  "AWS.CloudWatch.GetMetricStatistics",
  () => Effect.Effect<
    (
      request: GetMetricStatisticsRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricStatisticsOutput,
      cloudwatch.GetMetricStatisticsError
    >
  >
> {}

export const GetMetricStatistics = Binding.Service<GetMetricStatistics>(
  "AWS.CloudWatch.GetMetricStatistics",
);
