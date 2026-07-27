import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:StopResource` — halt an in-progress Forecast
 * job (dataset import, predictor training, forecast generation, or any of
 * their export jobs), the cost-control lever for a runaway training run. A
 * stopped job cannot be resumed.
 *
 * Job ARNs are created at runtime, so the binding takes no arguments and
 * grants `forecast:StopResource` on `*`. Provide the implementation with
 * `Effect.provide(AWS.Forecast.StopResourceHttp)`.
 *
 * @binding
 * @section Managing Jobs
 * @example Halt a Runaway Training Run
 * ```typescript
 * // init
 * const stopResource = yield* AWS.Forecast.StopResource();
 *
 * // runtime
 * yield* stopResource({ ResourceArn: predictorArn });
 * ```
 */
export interface StopResource extends Binding.Service<
  StopResource,
  "AWS.Forecast.StopResource",
  () => Effect.Effect<
    (
      request: forecast.StopResourceRequest,
    ) => Effect.Effect<
      forecast.StopResourceResponse,
      forecast.StopResourceError
    >
  >
> {}
export const StopResource = Binding.Service<StopResource>(
  "AWS.Forecast.StopResource",
);
