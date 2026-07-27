import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetUsageForecast}.
 */
export interface GetUsageForecastRequest extends ce.GetUsageForecastRequest {}

/**
 * Runtime binding for `ce:GetUsageForecast`.
 *
 * Forecast usage quantity (e.g. hours, requests) over a future time
 * period for a filtered slice of your usage. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetUsageForecastHttp)`.
 * @binding
 * @section Forecasting
 * @example Forecast Usage Quantity
 * ```typescript
 * // init — account-level binding takes no resource
 * const getUsageForecast = yield* AWS.CostExplorer.GetUsageForecast();
 *
 * // runtime
 * const result = yield* getUsageForecast({
 *   TimePeriod: { Start: "2026-08-01", End: "2026-09-01" },
 *   Metric: "USAGE_QUANTITY",
 *   Granularity: "MONTHLY",
 *   Filter: { Dimensions: { Key: "USAGE_TYPE_GROUP", Values: ["EC2: Running Hours"] } },
 * });
 * ```
 */
export interface GetUsageForecast extends Binding.Service<
  GetUsageForecast,
  "AWS.CostExplorer.GetUsageForecast",
  () => Effect.Effect<
    (
      request: GetUsageForecastRequest,
    ) => Effect.Effect<ce.GetUsageForecastResponse, ce.GetUsageForecastError>
  >
> {}

export const GetUsageForecast = Binding.Service<GetUsageForecast>(
  "AWS.CostExplorer.GetUsageForecast",
);
