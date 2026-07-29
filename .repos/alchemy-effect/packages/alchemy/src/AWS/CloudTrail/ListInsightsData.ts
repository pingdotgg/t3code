import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudtrail:ListInsightsData`.
 *
 * An account-level operation (no resource argument) that reads the raw
 * Insights events recorded for an insight source — empty when Insights has
 * recorded no anomalies. Rate-limited by AWS to two requests per second,
 * per account, per Region. Provide the implementation with
 * `Effect.provide(AWS.CloudTrail.ListInsightsDataHttp)`.
 * @binding
 * @section Reading Insights Events
 * @example List Insights Events
 * ```typescript
 * // init — account-level binding takes no resource
 * const listInsightsData = yield* AWS.CloudTrail.ListInsightsData();
 *
 * // runtime
 * const result = yield* listInsightsData({
 *   InsightSource: "s3.amazonaws.com",
 *   DataType: "InsightsEvents",
 *   MaxResults: 10,
 * });
 * console.log((result.Events ?? []).map((e) => e.EventName));
 * ```
 */
export interface ListInsightsData extends Binding.Service<
  ListInsightsData,
  "AWS.CloudTrail.ListInsightsData",
  () => Effect.Effect<
    (
      request: cloudtrail.ListInsightsDataRequest,
    ) => Effect.Effect<
      cloudtrail.ListInsightsDataResponse,
      cloudtrail.ListInsightsDataError
    >
  >
> {}
export const ListInsightsData = Binding.Service<ListInsightsData>(
  "AWS.CloudTrail.ListInsightsData",
);
