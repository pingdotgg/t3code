import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeWhatIfForecastExport` — poll the
 * status of a scenario-forecast export started with
 * {@link CreateWhatIfForecastExport} until the files land in S3.
 *
 * Export ARNs are created at runtime, so the binding takes no arguments and
 * grants `forecast:DescribeWhatIfForecastExport` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.Forecast.DescribeWhatIfForecastExportHttp)`.
 *
 * @binding
 * @section Exporting Forecasts
 * @example Poll a Scenario Export
 * ```typescript
 * // init
 * const describeWhatIfForecastExport =
 *   yield* AWS.Forecast.DescribeWhatIfForecastExport();
 *
 * // runtime
 * const { Status } = yield* describeWhatIfForecastExport({
 *   WhatIfForecastExportArn: exportArn,
 * });
 * ```
 */
export interface DescribeWhatIfForecastExport extends Binding.Service<
  DescribeWhatIfForecastExport,
  "AWS.Forecast.DescribeWhatIfForecastExport",
  () => Effect.Effect<
    (
      request: forecast.DescribeWhatIfForecastExportRequest,
    ) => Effect.Effect<
      forecast.DescribeWhatIfForecastExportResponse,
      forecast.DescribeWhatIfForecastExportError
    >
  >
> {}
export const DescribeWhatIfForecastExport =
  Binding.Service<DescribeWhatIfForecastExport>(
    "AWS.Forecast.DescribeWhatIfForecastExport",
  );
