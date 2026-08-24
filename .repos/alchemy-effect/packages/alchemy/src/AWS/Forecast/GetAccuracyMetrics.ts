import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:GetAccuracyMetrics` — read a trained
 * (legacy) predictor's backtest accuracy metrics (wQL, RMSE, MAPE, WAPE) so
 * an ops function can gate promotion of a retrained model on its accuracy.
 *
 * Predictor ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:GetAccuracyMetrics` on `*`. Provide the
 * implementation with `Effect.provide(AWS.Forecast.GetAccuracyMetricsHttp)`.
 *
 * @binding
 * @section Training Predictors
 * @example Gate on Accuracy
 * ```typescript
 * // init
 * const getAccuracyMetrics = yield* AWS.Forecast.GetAccuracyMetrics();
 *
 * // runtime
 * const metrics = yield* getAccuracyMetrics({
 *   PredictorArn: predictorArn,
 * });
 * ```
 */
export interface GetAccuracyMetrics extends Binding.Service<
  GetAccuracyMetrics,
  "AWS.Forecast.GetAccuracyMetrics",
  () => Effect.Effect<
    (
      request: forecast.GetAccuracyMetricsRequest,
    ) => Effect.Effect<
      forecast.GetAccuracyMetricsResponse,
      forecast.GetAccuracyMetricsError
    >
  >
> {}
export const GetAccuracyMetrics = Binding.Service<GetAccuracyMetrics>(
  "AWS.Forecast.GetAccuracyMetrics",
);
