import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Asset } from "./Asset.ts";

/**
 * Request for {@link GetInterpolatedAssetPropertyValues}. The bound asset's
 * id is injected automatically.
 *
 * The `startTimeInSeconds` / `endTimeInSeconds` / `intervalInSeconds`
 * fields keep their wire names: they are epoch timestamps and an interval
 * that are part of this operation's request shape, passed through verbatim.
 */
export interface GetInterpolatedAssetPropertyValuesRequest extends Omit<
  sitewise.GetInterpolatedAssetPropertyValuesRequest,
  "assetId"
> {}

/**
 * Runtime binding for `iotsitewise:GetInterpolatedAssetPropertyValues` —
 * compute interpolated values (`LINEAR_INTERPOLATION` or
 * `LOCF_INTERPOLATION`) of one property of the bound asset at a fixed
 * interval from a deployed Lambda or Task.
 *
 * @binding
 * @section Reading Interpolated Values
 * Provide the `GetInterpolatedAssetPropertyValuesHttp` implementation layer
 * on the Function effect, bind the asset in the init phase, then call the
 * returned client at runtime.
 *
 * @example Interpolate at 1-Minute Intervals
 * ```typescript
 * // init
 * const getInterpolated =
 *   yield* AWS.IoTSiteWise.GetInterpolatedAssetPropertyValues(asset);
 *
 * // runtime
 * const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
 * const { interpolatedAssetPropertyValues } = yield* getInterpolated({
 *   propertyId,
 *   startTimeInSeconds: now - 3600,
 *   endTimeInSeconds: now,
 *   intervalInSeconds: 60,
 *   quality: "GOOD",
 *   type: "LINEAR_INTERPOLATION",
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.GetInterpolatedAssetPropertyValuesHttp))
 * ```
 */
export interface GetInterpolatedAssetPropertyValues extends Binding.Service<
  GetInterpolatedAssetPropertyValues,
  "AWS.IoTSiteWise.GetInterpolatedAssetPropertyValues",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request: GetInterpolatedAssetPropertyValuesRequest,
    ) => Effect.Effect<
      sitewise.GetInterpolatedAssetPropertyValuesResponse,
      sitewise.GetInterpolatedAssetPropertyValuesError
    >
  >
> {}
export const GetInterpolatedAssetPropertyValues =
  Binding.Service<GetInterpolatedAssetPropertyValues>(
    "AWS.IoTSiteWise.GetInterpolatedAssetPropertyValues",
  );
