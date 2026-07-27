import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:CreateForecastExportJob` — export a complete
 * forecast to S3 as CSV/Parquet, the bulk-consumption path that complements
 * per-item lookups via {@link QueryForecast}.
 *
 * Export job ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:CreateForecastExportJob` on `*`, plus `iam:PassRole`
 * (conditioned to `forecast.amazonaws.com`) for the export destination role.
 * Provide the implementation with
 * `Effect.provide(AWS.Forecast.CreateForecastExportJobHttp)`.
 *
 * @binding
 * @section Exporting Forecasts
 * @example Export the Forecast to S3
 * ```typescript
 * // init
 * const createForecastExportJob = yield* AWS.Forecast.CreateForecastExportJob();
 *
 * // runtime
 * const job = yield* createForecastExportJob({
 *   ForecastExportJobName: "demand_2026_07_14_export",
 *   ForecastArn: forecastArn,
 *   Destination: {
 *     S3Config: { Path: "s3://my-bucket/forecasts/", RoleArn: exportRoleArn },
 *   },
 * });
 * ```
 */
export interface CreateForecastExportJob extends Binding.Service<
  CreateForecastExportJob,
  "AWS.Forecast.CreateForecastExportJob",
  () => Effect.Effect<
    (
      request: forecast.CreateForecastExportJobRequest,
    ) => Effect.Effect<
      forecast.CreateForecastExportJobResponse,
      forecast.CreateForecastExportJobError
    >
  >
> {}
export const CreateForecastExportJob = Binding.Service<CreateForecastExportJob>(
  "AWS.Forecast.CreateForecastExportJob",
);
