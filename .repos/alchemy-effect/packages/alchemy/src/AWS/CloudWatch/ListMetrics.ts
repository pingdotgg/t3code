import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListMetricsRequest extends cloudwatch.ListMetricsInput {}

/**
 * Runtime binding for `cloudwatch:ListMetrics` — enumerate the metrics
 * visible in the account/region, optionally filtered by namespace, metric
 * name, or dimensions.
 *
 * Provide `CloudWatch.ListMetricsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Listing Metrics
 * @example List Metrics in a Namespace
 * ```typescript
 * // init — grants cloudwatch:ListMetrics
 * const listMetrics = yield* AWS.CloudWatch.ListMetrics();
 *
 * // runtime
 * const result = yield* listMetrics({ Namespace: "MyApp/Payments" });
 * const names = (result.Metrics ?? []).map((metric) => metric.MetricName);
 * ```
 */
export interface ListMetrics extends Binding.Service<
  ListMetrics,
  "AWS.CloudWatch.ListMetrics",
  () => Effect.Effect<
    (
      request?: ListMetricsRequest,
    ) => Effect.Effect<
      cloudwatch.ListMetricsOutput,
      cloudwatch.ListMetricsError
    >
  >
> {}

export const ListMetrics = Binding.Service<ListMetrics>(
  "AWS.CloudWatch.ListMetrics",
);
