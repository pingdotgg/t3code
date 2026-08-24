import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCostForecast}.
 */
export interface GetCostForecastRequest extends ce.GetCostForecastRequest {}

/**
 * Runtime binding for `ce:GetCostForecast`.
 *
 * Forecast how much AWS predicts you will spend over a future time
 * period, with an optional prediction interval. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCostForecastHttp)`.
 * @binding
 * @section Forecasting
 * @example Forecast Next Month's Spend
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCostForecast = yield* AWS.CostExplorer.GetCostForecast();
 *
 * // runtime
 * const result = yield* getCostForecast({
 *   TimePeriod: { Start: "2026-08-01", End: "2026-09-01" },
 *   Metric: "UNBLENDED_COST",
 *   Granularity: "MONTHLY",
 * });
 * const forecast = result.Total?.Amount;
 * ```
 */
export interface GetCostForecast extends Binding.Service<
  GetCostForecast,
  "AWS.CostExplorer.GetCostForecast",
  () => Effect.Effect<
    (
      request: GetCostForecastRequest,
    ) => Effect.Effect<ce.GetCostForecastResponse, ce.GetCostForecastError>
  >
> {}

export const GetCostForecast = Binding.Service<GetCostForecast>(
  "AWS.CostExplorer.GetCostForecast",
);
