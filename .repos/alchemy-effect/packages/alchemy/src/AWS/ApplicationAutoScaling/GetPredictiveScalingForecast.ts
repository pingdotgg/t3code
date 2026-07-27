import type * as aas from "@distilled.cloud/aws/application-auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ScalingPolicy } from "./ScalingPolicy.ts";

/**
 * `GetPredictiveScalingForecast` request with the policy's identity triple
 * (`ServiceNamespace`/`ResourceId`/`ScalableDimension`) and `PolicyName`
 * injected from the bound {@link ScalingPolicy}.
 */
export interface GetPredictiveScalingForecastRequest extends Omit<
  aas.GetPredictiveScalingForecastRequest,
  "ServiceNamespace" | "ResourceId" | "ScalableDimension" | "PolicyName"
> {}

/**
 * Runtime binding for the `GetPredictiveScalingForecast` operation (IAM
 * action `application-autoscaling:GetPredictiveScalingForecast`).
 *
 * Retrieves the load and capacity forecast a predictive scaling policy has
 * computed for a time window (forecasts are created from at least 24 hours of
 * historical CloudWatch data). The bound policy must be a `PredictiveScaling`
 * policy on an ECS service: the API rejects other policy types with the typed
 * `ValidationException` and namespaces without predictive scaling support
 * with the typed `PredictiveScalingForecastNotSupported`. Provide the
 * implementation with
 * `Effect.provide(AWS.ApplicationAutoScaling.GetPredictiveScalingForecastHttp)`.
 * @binding
 * @section Reading Forecasts
 * @example Get the Next 48 Hours of Forecast
 * ```typescript
 * // init — bind the operation to the predictive scaling policy
 * const getPredictiveScalingForecast =
 *   yield* AWS.ApplicationAutoScaling.GetPredictiveScalingForecast(policy);
 *
 * // runtime — read the forecast window
 * const now = yield* Effect.sync(() => Date.now());
 * const forecast = yield* getPredictiveScalingForecast({
 *   StartTime: new Date(now),
 *   EndTime: new Date(now + 48 * 60 * 60 * 1000),
 * });
 * const capacity = forecast.CapacityForecast?.Values ?? [];
 * ```
 */
export interface GetPredictiveScalingForecast extends Binding.Service<
  GetPredictiveScalingForecast,
  "AWS.ApplicationAutoScaling.GetPredictiveScalingForecast",
  (
    policy: ScalingPolicy,
  ) => Effect.Effect<
    (
      request: GetPredictiveScalingForecastRequest,
    ) => Effect.Effect<
      aas.GetPredictiveScalingForecastResponse,
      aas.GetPredictiveScalingForecastError
    >
  >
> {}

export const GetPredictiveScalingForecast =
  Binding.Service<GetPredictiveScalingForecast>(
    "AWS.ApplicationAutoScaling.GetPredictiveScalingForecast",
  );
