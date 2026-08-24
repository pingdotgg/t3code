import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Asset } from "./Asset.ts";

/**
 * Request for {@link DescribeAsset}. The bound asset's id is injected
 * automatically.
 */
export interface DescribeAssetRequest extends Omit<
  sitewise.DescribeAssetRequest,
  "assetId"
> {}

/**
 * Runtime binding for `iotsitewise:DescribeAsset` — read the bound asset's
 * full description (including its properties with their service-assigned
 * ids and names) from a deployed Lambda or Task. Use it to resolve a
 * property's id by name before reading or ingesting values.
 *
 * @binding
 * @section Describing the Bound Asset
 * Provide the `DescribeAssetHttp` implementation layer on the Function
 * effect, bind the asset in the init phase, then call the returned client
 * at runtime.
 *
 * @example Resolve a Property Id by Name
 * ```typescript
 * // init
 * const describeAsset = yield* AWS.IoTSiteWise.DescribeAsset(asset);
 *
 * // runtime
 * const described = yield* describeAsset();
 * const propertyId = described.assetProperties.find(
 *   (p) => p.name === "Temperature",
 * )?.id;
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.DescribeAssetHttp))
 * ```
 */
export interface DescribeAsset extends Binding.Service<
  DescribeAsset,
  "AWS.IoTSiteWise.DescribeAsset",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request?: DescribeAssetRequest,
    ) => Effect.Effect<
      sitewise.DescribeAssetResponse,
      sitewise.DescribeAssetError
    >
  >
> {}
export const DescribeAsset = Binding.Service<DescribeAsset>(
  "AWS.IoTSiteWise.DescribeAsset",
);
