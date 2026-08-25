import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:CreateWhatIfForecastExport` — export one or
 * more scenario forecasts to S3 as CSV/Parquet so they can be compared
 * offline or fed into downstream analytics.
 *
 * What-if forecast export ARNs are created at runtime, so the binding takes
 * no arguments and grants `forecast:CreateWhatIfForecastExport` on `*`, plus
 * `iam:PassRole` (conditioned to `forecast.amazonaws.com`) for the export
 * destination role. Provide the implementation with
 * `Effect.provide(AWS.Forecast.CreateWhatIfForecastExportHttp)`.
 *
 * @binding
 * @section Exporting Forecasts
 * @example Export Scenario Forecasts
 * ```typescript
 * // init
 * const createWhatIfForecastExport =
 *   yield* AWS.Forecast.CreateWhatIfForecastExport();
 *
 * // runtime
 * const job = yield* createWhatIfForecastExport({
 *   WhatIfForecastExportName: "promo_scenarios_export",
 *   WhatIfForecastArns: [scenarioArn],
 *   Destination: {
 *     S3Config: { Path: "s3://my-bucket/whatif/", RoleArn: exportRoleArn },
 *   },
 * });
 * ```
 */
export interface CreateWhatIfForecastExport extends Binding.Service<
  CreateWhatIfForecastExport,
  "AWS.Forecast.CreateWhatIfForecastExport",
  () => Effect.Effect<
    (
      request: forecast.CreateWhatIfForecastExportRequest,
    ) => Effect.Effect<
      forecast.CreateWhatIfForecastExportResponse,
      forecast.CreateWhatIfForecastExportError
    >
  >
> {}
export const CreateWhatIfForecastExport =
  Binding.Service<CreateWhatIfForecastExport>(
    "AWS.Forecast.CreateWhatIfForecastExport",
  );
