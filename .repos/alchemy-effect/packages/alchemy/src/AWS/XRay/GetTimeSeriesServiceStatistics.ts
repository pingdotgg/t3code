import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetTimeSeriesServiceStatisticsRequest
  extends xray.GetTimeSeriesServiceStatisticsRequest {}

/**
 * Retrieve an aggregation of service statistics (response-time and error
 * histograms) as a time series over a window, optionally filtered by
 * group or entity selector expression.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTimeSeriesServiceStatisticsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetTimeSeriesServiceStatistics`, so the binding grants it on `*`.
 * @binding
 * @section Service Graphs & Statistics
 * @example Time-series statistics for one service
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetTimeSeriesServiceStatistics
 * const getTimeSeriesServiceStatistics =
 *   yield* XRay.GetTimeSeriesServiceStatistics();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const stats = yield* getTimeSeriesServiceStatistics({
 *   StartTime: new Date(now - 10 * 60 * 1000),
 *   EndTime: new Date(now),
 *   EntitySelectorExpression: 'service("my-api")',
 *   Period: 60,
 * });
 * const points = stats.TimeSeriesServiceStatistics ?? [];
 * ```
 */
export interface GetTimeSeriesServiceStatistics extends Binding.Service<
  GetTimeSeriesServiceStatistics,
  "AWS.XRay.GetTimeSeriesServiceStatistics",
  () => Effect.Effect<
    (
      request: GetTimeSeriesServiceStatisticsRequest,
    ) => Effect.Effect<
      xray.GetTimeSeriesServiceStatisticsResult,
      xray.GetTimeSeriesServiceStatisticsError
    >
  >
> {}
export const GetTimeSeriesServiceStatistics =
  Binding.Service<GetTimeSeriesServiceStatistics>(
    "AWS.XRay.GetTimeSeriesServiceStatistics",
  );
