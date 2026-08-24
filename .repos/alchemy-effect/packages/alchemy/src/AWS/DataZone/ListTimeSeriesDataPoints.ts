import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface ListTimeSeriesDataPointsRequest extends Omit<
  datazone.ListTimeSeriesDataPointsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:ListTimeSeriesDataPoints`.
 *
 * Lists time series data points recorded on an asset or listing in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.ListTimeSeriesDataPointsHttp)`.
 * @binding
 * @section Time Series Metadata
 * @example Read Back Metric History
 * ```typescript
 * // init — bind the operation to the domain
 * const listTimeSeriesDataPoints = yield* AWS.DataZone.ListTimeSeriesDataPoints(domain);
 *
 * // runtime
 * const points = yield* listTimeSeriesDataPoints({
 *   entityIdentifier: assetId,
 *   entityType: "ASSET",
 *   formName: "quality",
 * });
 * ```
 */
export interface ListTimeSeriesDataPoints extends Binding.Service<
  ListTimeSeriesDataPoints,
  "AWS.DataZone.ListTimeSeriesDataPoints",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: ListTimeSeriesDataPointsRequest,
    ) => Effect.Effect<
      datazone.ListTimeSeriesDataPointsOutput,
      datazone.ListTimeSeriesDataPointsError
    >
  >
> {}
export const ListTimeSeriesDataPoints =
  Binding.Service<ListTimeSeriesDataPoints>(
    "AWS.DataZone.ListTimeSeriesDataPoints",
  );
