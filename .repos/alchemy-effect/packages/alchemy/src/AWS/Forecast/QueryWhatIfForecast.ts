import type * as forecastquery from "@distilled.cloud/aws/forecastquery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:QueryWhatIfForecast` — retrieve the
 * predicted time series for a single item from a what-if forecast, so an
 * application can compare a scenario (price change, promotion) against the
 * baseline served by {@link QueryForecast}.
 *
 * What-if forecast ARNs are created at runtime, so the binding takes no
 * arguments and grants `forecast:QueryWhatIfForecast` on `*`. Provide the
 * implementation with `Effect.provide(AWS.Forecast.QueryWhatIfForecastHttp)`.
 *
 * @binding
 * @section Querying Forecasts
 * @example Compare a Scenario
 * ```typescript
 * // init
 * const queryWhatIfForecast = yield* AWS.Forecast.QueryWhatIfForecast();
 *
 * // runtime
 * const { Forecast } = yield* queryWhatIfForecast({
 *   WhatIfForecastArn: whatIfForecastArn,
 *   Filters: { item_id: "sku_1234" },
 * });
 * ```
 */
export interface QueryWhatIfForecast extends Binding.Service<
  QueryWhatIfForecast,
  "AWS.Forecast.QueryWhatIfForecast",
  () => Effect.Effect<
    (
      request: forecastquery.QueryWhatIfForecastRequest,
    ) => Effect.Effect<
      forecastquery.QueryWhatIfForecastResponse,
      forecastquery.QueryWhatIfForecastError
    >
  >
> {}
export const QueryWhatIfForecast = Binding.Service<QueryWhatIfForecast>(
  "AWS.Forecast.QueryWhatIfForecast",
);
