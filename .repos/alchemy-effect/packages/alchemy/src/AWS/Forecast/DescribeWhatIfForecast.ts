import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeWhatIfForecast` — poll the status of
 * a scenario forecast created with {@link CreateWhatIfForecast} until it is
 * `ACTIVE` and queryable via {@link QueryWhatIfForecast}.
 *
 * What-if forecast ARNs are created at runtime, so the binding takes no
 * arguments and grants `forecast:DescribeWhatIfForecast` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.Forecast.DescribeWhatIfForecastHttp)`.
 *
 * ### What-If Scenarios
 * **Example:** Poll a Scenario Forecast
 * ```typescript
 * // init
 * const describeWhatIfForecast = yield* AWS.Forecast.DescribeWhatIfForecast();
 *
 * // runtime
 * const { Status } = yield* describeWhatIfForecast({
 *   WhatIfForecastArn: scenarioArn,
 * });
 * ```
 *
 * @binding
 */
export interface DescribeWhatIfForecast extends Binding.Service<
  DescribeWhatIfForecast,
  "AWS.Forecast.DescribeWhatIfForecast",
  () => Effect.Effect<
    (
      request: forecast.DescribeWhatIfForecastRequest,
    ) => Effect.Effect<
      forecast.DescribeWhatIfForecastResponse,
      forecast.DescribeWhatIfForecastError
    >
  >
> {}
export const DescribeWhatIfForecast = Binding.Service<DescribeWhatIfForecast>(
  "AWS.Forecast.DescribeWhatIfForecast",
);
