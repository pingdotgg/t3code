import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetMetricWidgetImageRequest
  extends cloudwatch.GetMetricWidgetImageInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricWidgetImage` — render a metric
 * graph as a PNG (useful for embedding charts in alerts or reports).
 *
 * Provide `CloudWatch.GetMetricWidgetImageHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Rendering Metric Graphs
 * @example Render a Metric Graph as PNG
 * ```typescript
 * // init — grants cloudwatch:GetMetricWidgetImage
 * const getMetricWidgetImage = yield* AWS.CloudWatch.GetMetricWidgetImage();
 *
 * // runtime
 * const result = yield* getMetricWidgetImage({
 *   MetricWidget: JSON.stringify({
 *     metrics: [["MyApp/Payments", "PaymentProcessed"]],
 *     width: 600,
 *     height: 400,
 *     start: "-PT3H",
 *   }),
 * });
 * const png = result.MetricWidgetImage; // image bytes
 * ```
 */
export interface GetMetricWidgetImage extends Binding.Service<
  GetMetricWidgetImage,
  "AWS.CloudWatch.GetMetricWidgetImage",
  () => Effect.Effect<
    (
      request: GetMetricWidgetImageRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricWidgetImageOutput,
      cloudwatch.GetMetricWidgetImageError
    >
  >
> {}

export const GetMetricWidgetImage = Binding.Service<GetMetricWidgetImage>(
  "AWS.CloudWatch.GetMetricWidgetImage",
);
