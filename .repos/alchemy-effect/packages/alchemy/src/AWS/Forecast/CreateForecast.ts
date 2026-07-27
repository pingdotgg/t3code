import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:CreateForecast` — generate a fresh forecast
 * from a trained predictor, the scheduled step that keeps the queryable
 * forecast current after each retraining or data import.
 *
 * Forecast ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:CreateForecast` on `*`. Provide the implementation
 * with `Effect.provide(AWS.Forecast.CreateForecastHttp)`.
 *
 * @binding
 * @section Generating Forecasts
 * @example Regenerate the Forecast
 * ```typescript
 * // init
 * const createForecast = yield* AWS.Forecast.CreateForecast();
 *
 * // runtime
 * const generated = yield* createForecast({
 *   ForecastName: "demand_2026_07_14",
 *   PredictorArn: predictorArn,
 * });
 * ```
 */
export interface CreateForecast extends Binding.Service<
  CreateForecast,
  "AWS.Forecast.CreateForecast",
  () => Effect.Effect<
    (
      request: forecast.CreateForecastRequest,
    ) => Effect.Effect<
      forecast.CreateForecastResponse,
      forecast.CreateForecastError
    >
  >
> {}
export const CreateForecast = Binding.Service<CreateForecast>(
  "AWS.Forecast.CreateForecast",
);
