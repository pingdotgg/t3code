import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudtrail:ListInsightsMetricData`.
 *
 * An account-level operation (no resource argument) that reads the Insights
 * metric time series (API call rate / error rate) for a given event source
 * and event name — empty when Insights has recorded no anomalies. Provide
 * the implementation with
 * `Effect.provide(AWS.CloudTrail.ListInsightsMetricDataHttp)`.
 * @binding
 * @section Reading Insights Metrics
 * @example Read API Call Rate Metrics
 * ```typescript
 * // init — account-level binding takes no resource
 * const listInsightsMetricData =
 *   yield* AWS.CloudTrail.ListInsightsMetricData();
 *
 * // runtime
 * const result = yield* listInsightsMetricData({
 *   EventSource: "s3.amazonaws.com",
 *   EventName: "PutObject",
 *   InsightType: "ApiCallRateInsight",
 * });
 * console.log(result.Timestamps?.length, result.Values?.length);
 * ```
 */
export interface ListInsightsMetricData extends Binding.Service<
  ListInsightsMetricData,
  "AWS.CloudTrail.ListInsightsMetricData",
  () => Effect.Effect<
    (
      request: cloudtrail.ListInsightsMetricDataRequest,
    ) => Effect.Effect<
      cloudtrail.ListInsightsMetricDataResponse,
      cloudtrail.ListInsightsMetricDataError
    >
  >
> {}
export const ListInsightsMetricData = Binding.Service<ListInsightsMetricData>(
  "AWS.CloudTrail.ListInsightsMetricData",
);
