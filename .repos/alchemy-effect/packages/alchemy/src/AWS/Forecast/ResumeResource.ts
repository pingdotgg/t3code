import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:ResumeResource` — resume a stopped Forecast
 * monitor so it continues evaluating a deployed predictor's drift.
 *
 * Monitor ARNs are created at runtime, so the binding takes no arguments and
 * grants `forecast:ResumeResource` on `*`. Provide the implementation with
 * `Effect.provide(AWS.Forecast.ResumeResourceHttp)`.
 *
 * @binding
 * @section Managing Jobs
 * @example Resume a Stopped Monitor
 * ```typescript
 * // init
 * const resumeResource = yield* AWS.Forecast.ResumeResource();
 *
 * // runtime
 * yield* resumeResource({ ResourceArn: monitorArn });
 * ```
 */
export interface ResumeResource extends Binding.Service<
  ResumeResource,
  "AWS.Forecast.ResumeResource",
  () => Effect.Effect<
    (
      request: forecast.ResumeResourceRequest,
    ) => Effect.Effect<
      forecast.ResumeResourceResponse,
      forecast.ResumeResourceError
    >
  >
> {}
export const ResumeResource = Binding.Service<ResumeResource>(
  "AWS.Forecast.ResumeResource",
);
