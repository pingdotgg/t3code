import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:CreateWhatIfAnalysis` — start a what-if
 * analysis on a baseline forecast, the container under which scenario
 * forecasts (price changes, promotions) are created and later compared via
 * {@link QueryWhatIfForecast}.
 *
 * What-if analysis ARNs are created at runtime, so the binding takes no
 * arguments and grants `forecast:CreateWhatIfAnalysis` on `*`. Provide the
 * implementation with `Effect.provide(AWS.Forecast.CreateWhatIfAnalysisHttp)`.
 *
 * @binding
 * @section What-If Scenarios
 * @example Start a What-If Analysis
 * ```typescript
 * // init
 * const createWhatIfAnalysis = yield* AWS.Forecast.CreateWhatIfAnalysis();
 *
 * // runtime
 * const analysis = yield* createWhatIfAnalysis({
 *   WhatIfAnalysisName: "promo_scenarios",
 *   ForecastArn: forecastArn,
 * });
 * ```
 */
export interface CreateWhatIfAnalysis extends Binding.Service<
  CreateWhatIfAnalysis,
  "AWS.Forecast.CreateWhatIfAnalysis",
  () => Effect.Effect<
    (
      request: forecast.CreateWhatIfAnalysisRequest,
    ) => Effect.Effect<
      forecast.CreateWhatIfAnalysisResponse,
      forecast.CreateWhatIfAnalysisError
    >
  >
> {}
export const CreateWhatIfAnalysis = Binding.Service<CreateWhatIfAnalysis>(
  "AWS.Forecast.CreateWhatIfAnalysis",
);
