import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface PostTimeSeriesDataPointsRequest extends Omit<
  datazone.PostTimeSeriesDataPointsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:PostTimeSeriesDataPoints`.
 *
 * Posts time series data points (e.g. data-quality metrics) onto an asset or listing in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.PostTimeSeriesDataPointsHttp)`.
 * @binding
 * @section Time Series Metadata
 * @example Record Data Quality Metrics
 * ```typescript
 * // init — bind the operation to the domain
 * const postTimeSeriesDataPoints = yield* AWS.DataZone.PostTimeSeriesDataPoints(domain);
 *
 * // runtime
 * yield* postTimeSeriesDataPoints({
 *   entityIdentifier: assetId,
 *   entityType: "ASSET",
 *   forms: [{ formName: "quality", typeIdentifier: "amazon.datazone.DataQualityResultFormType", content: "{}", timestamp: new Date() }],
 * });
 * ```
 */
export interface PostTimeSeriesDataPoints extends Binding.Service<
  PostTimeSeriesDataPoints,
  "AWS.DataZone.PostTimeSeriesDataPoints",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: PostTimeSeriesDataPointsRequest,
    ) => Effect.Effect<
      datazone.PostTimeSeriesDataPointsOutput,
      datazone.PostTimeSeriesDataPointsError
    >
  >
> {}
export const PostTimeSeriesDataPoints =
  Binding.Service<PostTimeSeriesDataPoints>(
    "AWS.DataZone.PostTimeSeriesDataPoints",
  );
