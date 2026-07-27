import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:CreateAutoPredictor` — kick off (re)training
 * of an AutoPredictor from a dataset group, the scheduled-retraining step of
 * a grandfathered Forecast deployment. Also grants `iam:PassRole`
 * (conditioned to `forecast.amazonaws.com`) for the KMS-encryption role an
 * `EncryptionConfig` passes to the service.
 *
 * Predictor ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:CreateAutoPredictor` on `*`. Provide the
 * implementation with `Effect.provide(AWS.Forecast.CreateAutoPredictorHttp)`.
 *
 * @binding
 * @section Training Predictors
 * @example Retrain a Predictor
 * ```typescript
 * // init
 * const createAutoPredictor = yield* AWS.Forecast.CreateAutoPredictor();
 *
 * // runtime
 * const predictor = yield* createAutoPredictor({
 *   PredictorName: "demand_2026_07",
 *   ForecastHorizon: 14,
 *   ForecastFrequency: "D",
 *   DataConfig: { DatasetGroupArn: group.datasetGroupArn },
 * });
 * ```
 */
export interface CreateAutoPredictor extends Binding.Service<
  CreateAutoPredictor,
  "AWS.Forecast.CreateAutoPredictor",
  () => Effect.Effect<
    (
      request: forecast.CreateAutoPredictorRequest,
    ) => Effect.Effect<
      forecast.CreateAutoPredictorResponse,
      forecast.CreateAutoPredictorError
    >
  >
> {}
export const CreateAutoPredictor = Binding.Service<CreateAutoPredictor>(
  "AWS.Forecast.CreateAutoPredictor",
);
