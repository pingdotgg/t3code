import type * as forecastquery from "@distilled.cloud/aws/forecastquery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:QueryForecast` — the Forecast Query data
 * plane. Retrieves the predicted time series for a single item from a
 * generated forecast, the call an API or personalization function makes to
 * serve predictions.
 *
 * Forecast ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:QueryForecast` on `*`. Provide the implementation
 * with `Effect.provide(AWS.Forecast.QueryForecastHttp)`.
 *
 * @binding
 * @section Querying Forecasts
 * @example Serve a Prediction
 * ```typescript
 * // init
 * const queryForecast = yield* AWS.Forecast.QueryForecast();
 *
 * // runtime
 * const { Forecast } = yield* queryForecast({
 *   ForecastArn: forecastArn,
 *   Filters: { item_id: "sku_1234" },
 * });
 * const p50 = Forecast?.Predictions?.p50 ?? [];
 * ```
 */
export interface QueryForecast extends Binding.Service<
  QueryForecast,
  "AWS.Forecast.QueryForecast",
  () => Effect.Effect<
    (
      request: forecastquery.QueryForecastRequest,
    ) => Effect.Effect<
      forecastquery.QueryForecastResponse,
      forecastquery.QueryForecastError
    >
  >
> {}
export const QueryForecast = Binding.Service<QueryForecast>(
  "AWS.Forecast.QueryForecast",
);
