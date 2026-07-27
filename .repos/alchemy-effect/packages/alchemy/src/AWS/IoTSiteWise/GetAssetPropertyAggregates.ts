import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Asset } from "./Asset.ts";

/**
 * Request for {@link GetAssetPropertyAggregates}. The bound asset's id is
 * injected automatically.
 */
export interface GetAssetPropertyAggregatesRequest extends Omit<
  sitewise.GetAssetPropertyAggregatesRequest,
  "assetId"
> {}

/**
 * Runtime binding for `iotsitewise:GetAssetPropertyAggregates` — read
 * pre-computed aggregates (`AVERAGE`, `MINIMUM`, `MAXIMUM`, `SUM`, `COUNT`,
 * `STANDARD_DEVIATION`) of one property of the bound asset over a time
 * range at a fixed resolution from a deployed Lambda or Task.
 *
 * @binding
 * @section Reading Aggregates
 * Provide the `GetAssetPropertyAggregatesHttp` implementation layer on the
 * Function effect, bind the asset in the init phase, then call the returned
 * client at runtime.
 *
 * @example Hourly Average over the Last Day
 * ```typescript
 * // init
 * const getAggregates = yield* AWS.IoTSiteWise.GetAssetPropertyAggregates(asset);
 *
 * // runtime
 * const now = yield* Effect.sync(() => new Date());
 * const { aggregatedValues } = yield* getAggregates({
 *   propertyId,
 *   aggregateTypes: ["AVERAGE"],
 *   resolution: "1h",
 *   startDate: new Date(now.getTime() - 86_400_000),
 *   endDate: now,
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.GetAssetPropertyAggregatesHttp))
 * ```
 */
export interface GetAssetPropertyAggregates extends Binding.Service<
  GetAssetPropertyAggregates,
  "AWS.IoTSiteWise.GetAssetPropertyAggregates",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request: GetAssetPropertyAggregatesRequest,
    ) => Effect.Effect<
      sitewise.GetAssetPropertyAggregatesResponse,
      sitewise.GetAssetPropertyAggregatesError
    >
  >
> {}
export const GetAssetPropertyAggregates =
  Binding.Service<GetAssetPropertyAggregates>(
    "AWS.IoTSiteWise.GetAssetPropertyAggregates",
  );
