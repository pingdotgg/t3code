import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetMetricDataRequest extends cloudwatch.GetMetricDataInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricData` — run metric-math queries
 * over one or more metrics in a single call.
 *
 * Provide `CloudWatch.GetMetricDataHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Querying Metrics
 * @example Query the Last Hour of a Custom Metric
 * ```typescript
 * // init — grants cloudwatch:GetMetricData
 * const getMetricData = yield* AWS.CloudWatch.GetMetricData();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const result = yield* getMetricData({
 *   StartTime: new Date(now - 3_600_000),
 *   EndTime: new Date(now),
 *   MetricDataQueries: [
 *     {
 *       Id: "m1",
 *       MetricStat: {
 *         Metric: { Namespace: "MyApp/Payments", MetricName: "PaymentProcessed" },
 *         Period: 60,
 *         Stat: "Sum",
 *       },
 *     },
 *   ],
 * });
 * const series = result.MetricDataResults ?? [];
 * ```
 */
export interface GetMetricData extends Binding.Service<
  GetMetricData,
  "AWS.CloudWatch.GetMetricData",
  () => Effect.Effect<
    (
      request: GetMetricDataRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricDataOutput,
      cloudwatch.GetMetricDataError
    >
  >
> {}

export const GetMetricData = Binding.Service<GetMetricData>(
  "AWS.CloudWatch.GetMetricData",
);
