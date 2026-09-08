import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:BatchGetMetricData`.
 *
 * Fetches up to 10 aggregated deliverability metric time-series in one call —
 * sends, deliveries, bounces, complaints, opens, clicks — over a date range,
 * optionally sliced by dimension (ISP, configuration set, etc.). Requires VDM
 * (Virtual Deliverability Manager) to be enabled; a malformed query surfaces
 * the typed `BadRequestException`. Account-level operation. Provide the
 * implementation with `Effect.provide(AWS.SES.BatchGetMetricDataHttp)`.
 * ### Deliverability Insights
 * **Example:** Query Send and Delivery Counts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getMetrics = yield* SES.BatchGetMetricData();
 *
 * // runtime
 * const { Results } = yield* getMetrics({
 *   Queries: [
 *     {
 *       Id: "sends",
 *       Namespace: "VDM",
 *       Metric: "SEND",
 *       StartDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
 *       EndDate: new Date(),
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface BatchGetMetricData extends Binding.Service<
  BatchGetMetricData,
  "AWS.SES.BatchGetMetricData",
  () => Effect.Effect<
    (
      request: sesv2.BatchGetMetricDataRequest,
    ) => Effect.Effect<
      sesv2.BatchGetMetricDataResponse,
      sesv2.BatchGetMetricDataError
    >
  >
> {}
export const BatchGetMetricData = Binding.Service<BatchGetMetricData>(
  "AWS.SES.BatchGetMetricData",
);
