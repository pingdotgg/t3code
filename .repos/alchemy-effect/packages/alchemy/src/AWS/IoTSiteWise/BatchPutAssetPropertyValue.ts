import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Asset } from "./Asset.ts";

/**
 * One entry of a {@link BatchPutAssetPropertyValue} request. The bound
 * asset's id is injected automatically unless the entry targets a data
 * stream by `propertyAlias`.
 */
export interface PutAssetPropertyValueEntry extends Omit<
  sitewise.PutAssetPropertyValueEntry,
  "assetId"
> {}

/**
 * Request for {@link BatchPutAssetPropertyValue}.
 */
export interface BatchPutAssetPropertyValueRequest {
  /**
   * Whether to continue processing the remaining entries when one entry
   * fails.
   */
  enablePartialEntryProcessing?: boolean;
  /**
   * Up to 10 entries, each carrying up to 10 timestamp-quality-value (TQV)
   * data points for one property of the bound asset.
   */
  entries: PutAssetPropertyValueEntry[];
}

/**
 * Runtime binding for `iotsitewise:BatchPutAssetPropertyValue` — ingest
 * timestamped property values (measurements) into the bound asset's data
 * streams from a deployed Lambda or Task.
 *
 * @binding
 * @section Ingesting Property Values
 * Provide the `BatchPutAssetPropertyValueHttp` implementation layer on the
 * Function effect, bind the asset in the init phase, then call the returned
 * client at runtime. The binding grants
 * `iotsitewise:BatchPutAssetPropertyValue` on the asset and injects its id
 * into every entry automatically.
 *
 * @example Ingest a Temperature Reading
 * ```typescript
 * // init
 * const asset = yield* AWS.IoTSiteWise.Asset("Pump1", {
 *   assetModelId: model.assetModelId,
 * });
 * const putValues = yield* AWS.IoTSiteWise.BatchPutAssetPropertyValue(asset);
 *
 * // runtime
 * const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
 * const { errorEntries } = yield* putValues({
 *   entries: [
 *     {
 *       entryId: "temp-1",
 *       propertyId,
 *       propertyValues: [
 *         {
 *           value: { doubleValue: 23.5 },
 *           timestamp: { timeInSeconds: now },
 *           quality: "GOOD",
 *         },
 *       ],
 *     },
 *   ],
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.BatchPutAssetPropertyValueHttp))
 * ```
 */
export interface BatchPutAssetPropertyValue extends Binding.Service<
  BatchPutAssetPropertyValue,
  "AWS.IoTSiteWise.BatchPutAssetPropertyValue",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request: BatchPutAssetPropertyValueRequest,
    ) => Effect.Effect<
      sitewise.BatchPutAssetPropertyValueResponse,
      sitewise.BatchPutAssetPropertyValueError
    >
  >
> {}
export const BatchPutAssetPropertyValue =
  Binding.Service<BatchPutAssetPropertyValue>(
    "AWS.IoTSiteWise.BatchPutAssetPropertyValue",
  );
