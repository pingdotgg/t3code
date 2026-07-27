import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeWhatIfAnalysis` — poll the status of
 * a what-if analysis created with {@link CreateWhatIfAnalysis} until it is
 * `ACTIVE` and scenario forecasts can be created under it.
 *
 * What-if analysis ARNs are created at runtime, so the binding takes no
 * arguments and grants `forecast:DescribeWhatIfAnalysis` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.Forecast.DescribeWhatIfAnalysisHttp)`.
 *
 * @binding
 * @section What-If Scenarios
 * @example Poll a What-If Analysis
 * ```typescript
 * // init
 * const describeWhatIfAnalysis = yield* AWS.Forecast.DescribeWhatIfAnalysis();
 *
 * // runtime
 * const { Status } = yield* describeWhatIfAnalysis({
 *   WhatIfAnalysisArn: analysisArn,
 * });
 * ```
 */
export interface DescribeWhatIfAnalysis extends Binding.Service<
  DescribeWhatIfAnalysis,
  "AWS.Forecast.DescribeWhatIfAnalysis",
  () => Effect.Effect<
    (
      request: forecast.DescribeWhatIfAnalysisRequest,
    ) => Effect.Effect<
      forecast.DescribeWhatIfAnalysisResponse,
      forecast.DescribeWhatIfAnalysisError
    >
  >
> {}
export const DescribeWhatIfAnalysis = Binding.Service<DescribeWhatIfAnalysis>(
  "AWS.Forecast.DescribeWhatIfAnalysis",
);
