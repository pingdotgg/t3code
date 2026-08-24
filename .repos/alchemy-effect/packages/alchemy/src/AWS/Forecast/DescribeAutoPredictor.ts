import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeAutoPredictor` — poll a training run
 * started by {@link CreateAutoPredictor} until its `Status` reaches `ACTIVE`
 * (or `CREATE_FAILED`) and read its estimated time remaining.
 *
 * Predictor ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:DescribeAutoPredictor` on `*`. Provide the
 * implementation with `Effect.provide(AWS.Forecast.DescribeAutoPredictorHttp)`.
 *
 * @binding
 * @section Training Predictors
 * @example Poll a Training Run
 * ```typescript
 * // init
 * const describeAutoPredictor = yield* AWS.Forecast.DescribeAutoPredictor();
 *
 * // runtime
 * const detail = yield* describeAutoPredictor({
 *   PredictorArn: predictor.PredictorArn!,
 * });
 * yield* Effect.log(`training ${detail.Status}`);
 * ```
 */
export interface DescribeAutoPredictor extends Binding.Service<
  DescribeAutoPredictor,
  "AWS.Forecast.DescribeAutoPredictor",
  () => Effect.Effect<
    (
      request: forecast.DescribeAutoPredictorRequest,
    ) => Effect.Effect<
      forecast.DescribeAutoPredictorResponse,
      forecast.DescribeAutoPredictorError
    >
  >
> {}
export const DescribeAutoPredictor = Binding.Service<DescribeAutoPredictor>(
  "AWS.Forecast.DescribeAutoPredictor",
);
