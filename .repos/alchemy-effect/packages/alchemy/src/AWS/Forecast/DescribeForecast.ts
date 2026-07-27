import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeForecast` — poll a forecast
 * generation started by {@link CreateForecast} until its `Status` reaches
 * `ACTIVE` and it becomes queryable.
 *
 * Forecast ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:DescribeForecast` on `*`. Provide the implementation
 * with `Effect.provide(AWS.Forecast.DescribeForecastHttp)`.
 *
 * @binding
 * @section Generating Forecasts
 * @example Wait for a Forecast to Become Queryable
 * ```typescript
 * // init
 * const describeForecast = yield* AWS.Forecast.DescribeForecast();
 *
 * // runtime
 * const detail = yield* describeForecast({
 *   ForecastArn: generated.ForecastArn!,
 * });
 * yield* Effect.log(`forecast ${detail.Status}`);
 * ```
 */
export interface DescribeForecast extends Binding.Service<
  DescribeForecast,
  "AWS.Forecast.DescribeForecast",
  () => Effect.Effect<
    (
      request: forecast.DescribeForecastRequest,
    ) => Effect.Effect<
      forecast.DescribeForecastResponse,
      forecast.DescribeForecastError
    >
  >
> {}
export const DescribeForecast = Binding.Service<DescribeForecast>(
  "AWS.Forecast.DescribeForecast",
);
