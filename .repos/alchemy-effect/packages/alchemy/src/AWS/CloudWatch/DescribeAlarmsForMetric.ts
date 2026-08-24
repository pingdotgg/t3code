import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAlarmsForMetricRequest
  extends cloudwatch.DescribeAlarmsForMetricInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmsForMetric` — find the
 * alarms watching a specific metric.
 *
 * Provide `CloudWatch.DescribeAlarmsForMetricHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Alarm State
 * @example Find Alarms Watching a Metric
 * ```typescript
 * // init — grants cloudwatch:DescribeAlarmsForMetric
 * const describeAlarmsForMetric = yield* AWS.CloudWatch.DescribeAlarmsForMetric();
 *
 * // runtime
 * const result = yield* describeAlarmsForMetric({
 *   Namespace: "MyApp/Payments",
 *   MetricName: "PaymentProcessed",
 *   Statistic: "Sum",
 *   Period: 60,
 * });
 * const alarmNames = (result.MetricAlarms ?? []).map((a) => a.AlarmName);
 * ```
 */
export interface DescribeAlarmsForMetric extends Binding.Service<
  DescribeAlarmsForMetric,
  "AWS.CloudWatch.DescribeAlarmsForMetric",
  () => Effect.Effect<
    (
      request: DescribeAlarmsForMetricRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmsForMetricOutput,
      cloudwatch.DescribeAlarmsForMetricError
    >
  >
> {}

export const DescribeAlarmsForMetric = Binding.Service<DescribeAlarmsForMetric>(
  "AWS.CloudWatch.DescribeAlarmsForMetric",
);
