import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetTimeSeriesDataPointRequest extends Omit<
  datazone.GetTimeSeriesDataPointInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetTimeSeriesDataPoint`.
 *
 * Reads a single time series data point on an asset or listing in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetTimeSeriesDataPointHttp)`.
 * @binding
 * @section Time Series Metadata
 * @example Read One Data Point
 * ```typescript
 * // init — bind the operation to the domain
 * const getTimeSeriesDataPoint = yield* AWS.DataZone.GetTimeSeriesDataPoint(domain);
 *
 * // runtime
 * const point = yield* getTimeSeriesDataPoint({
 *   entityIdentifier: assetId,
 *   entityType: "ASSET",
 *   formName: "quality",
 *   identifier: dataPointId,
 * });
 * ```
 */
export interface GetTimeSeriesDataPoint extends Binding.Service<
  GetTimeSeriesDataPoint,
  "AWS.DataZone.GetTimeSeriesDataPoint",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetTimeSeriesDataPointRequest,
    ) => Effect.Effect<
      datazone.GetTimeSeriesDataPointOutput,
      datazone.GetTimeSeriesDataPointError
    >
  >
> {}
export const GetTimeSeriesDataPoint = Binding.Service<GetTimeSeriesDataPoint>(
  "AWS.DataZone.GetTimeSeriesDataPoint",
);
