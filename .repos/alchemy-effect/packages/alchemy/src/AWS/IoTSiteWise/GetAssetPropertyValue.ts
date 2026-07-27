import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Asset } from "./Asset.ts";

/**
 * Request for {@link GetAssetPropertyValue}. The bound asset's id is
 * injected automatically; identify the property with `propertyId` (or a
 * `propertyAlias`, which authorizes against the time-series resource
 * instead of the bound asset).
 */
export interface GetAssetPropertyValueRequest extends Omit<
  sitewise.GetAssetPropertyValueRequest,
  "assetId"
> {}

/**
 * Runtime binding for `iotsitewise:GetAssetPropertyValue` — read the
 * current (latest) timestamp-quality-value of one property of the bound
 * asset from a deployed Lambda or Task.
 *
 * @binding
 * @section Reading Current Values
 * Provide the `GetAssetPropertyValueHttp` implementation layer on the
 * Function effect, bind the asset in the init phase, then call the returned
 * client at runtime.
 *
 * @example Read the Latest Temperature
 * ```typescript
 * // init
 * const getValue = yield* AWS.IoTSiteWise.GetAssetPropertyValue(asset);
 *
 * // runtime
 * const { propertyValue } = yield* getValue({ propertyId });
 * const celsius = propertyValue?.value.doubleValue;
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.GetAssetPropertyValueHttp))
 * ```
 */
export interface GetAssetPropertyValue extends Binding.Service<
  GetAssetPropertyValue,
  "AWS.IoTSiteWise.GetAssetPropertyValue",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request: GetAssetPropertyValueRequest,
    ) => Effect.Effect<
      sitewise.GetAssetPropertyValueResponse,
      sitewise.GetAssetPropertyValueError
    >
  >
> {}
export const GetAssetPropertyValue = Binding.Service<GetAssetPropertyValue>(
  "AWS.IoTSiteWise.GetAssetPropertyValue",
);
