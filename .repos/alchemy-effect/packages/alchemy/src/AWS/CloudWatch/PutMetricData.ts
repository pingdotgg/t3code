import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PutMetricDataRequest extends cloudwatch.PutMetricDataInput {}

/**
 * Runtime binding for `cloudwatch:PutMetricData` — publish custom metric
 * datums from inside a function runtime.
 *
 * Provide `CloudWatch.PutMetricDataHttp` on the hosting Lambda Function to
 * satisfy the requirement. For high-volume publishing prefer the batching
 * {@link MetricSink}, which packs datums into 1000-datum `PutMetricData`
 * calls.
 * @binding
 * @section Publishing Metrics
 * @example Publish a Custom Metric from a Lambda Function
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     // init — grants cloudwatch:PutMetricData to the function
 *     const putMetricData = yield* AWS.CloudWatch.PutMetricData();
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — publish a datum on every request
 *         yield* putMetricData({
 *           Namespace: "MyApp/Payments",
 *           MetricData: [
 *             { MetricName: "PaymentProcessed", Value: 1, Unit: "Count" },
 *           ],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.CloudWatch.PutMetricDataHttp)),
 * );
 * ```
 */
export interface PutMetricData extends Binding.Service<
  PutMetricData,
  "AWS.CloudWatch.PutMetricData",
  () => Effect.Effect<
    (
      request: PutMetricDataRequest,
    ) => Effect.Effect<
      cloudwatch.PutMetricDataResponse,
      cloudwatch.PutMetricDataError
    >
  >
> {}

export const PutMetricData = Binding.Service<PutMetricData>(
  "AWS.CloudWatch.PutMetricData",
);
