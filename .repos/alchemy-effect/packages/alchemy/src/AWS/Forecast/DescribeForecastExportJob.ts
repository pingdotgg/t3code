import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeForecastExportJob` — poll the status
 * of a forecast export started with {@link CreateForecastExportJob} until
 * the files land in S3.
 *
 * Export job ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:DescribeForecastExportJob` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.Forecast.DescribeForecastExportJobHttp)`.
 *
 * @binding
 * @section Exporting Forecasts
 * @example Poll an Export Job
 * ```typescript
 * // init
 * const describeForecastExportJob =
 *   yield* AWS.Forecast.DescribeForecastExportJob();
 *
 * // runtime
 * const { Status } = yield* describeForecastExportJob({
 *   ForecastExportJobArn: exportJobArn,
 * });
 * ```
 */
export interface DescribeForecastExportJob extends Binding.Service<
  DescribeForecastExportJob,
  "AWS.Forecast.DescribeForecastExportJob",
  () => Effect.Effect<
    (
      request: forecast.DescribeForecastExportJobRequest,
    ) => Effect.Effect<
      forecast.DescribeForecastExportJobResponse,
      forecast.DescribeForecastExportJobError
    >
  >
> {}
export const DescribeForecastExportJob =
  Binding.Service<DescribeForecastExportJob>(
    "AWS.Forecast.DescribeForecastExportJob",
  );
