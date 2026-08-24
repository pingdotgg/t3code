import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Asset } from "./Asset.ts";

/**
 * Request for {@link ListAssetProperties}. The bound asset's id is injected
 * automatically.
 */
export interface ListAssetPropertiesRequest extends Omit<
  sitewise.ListAssetPropertiesRequest,
  "assetId"
> {}

/**
 * Runtime binding for `iotsitewise:ListAssetProperties` — page through the
 * bound asset's property summaries (ids, aliases, paths) from a deployed
 * Lambda or Task.
 *
 * @binding
 * @section Listing Asset Properties
 * Provide the `ListAssetPropertiesHttp` implementation layer on the
 * Function effect, bind the asset in the init phase, then call the returned
 * client at runtime. Pass `filter: "ALL"` to include properties inherited
 * from composite models.
 *
 * @example List All Properties
 * ```typescript
 * // init
 * const listProperties = yield* AWS.IoTSiteWise.ListAssetProperties(asset);
 *
 * // runtime
 * const { assetPropertySummaries } = yield* listProperties({ filter: "ALL" });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.ListAssetPropertiesHttp))
 * ```
 */
export interface ListAssetProperties extends Binding.Service<
  ListAssetProperties,
  "AWS.IoTSiteWise.ListAssetProperties",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request?: ListAssetPropertiesRequest,
    ) => Effect.Effect<
      sitewise.ListAssetPropertiesResponse,
      sitewise.ListAssetPropertiesError
    >
  >
> {}
export const ListAssetProperties = Binding.Service<ListAssetProperties>(
  "AWS.IoTSiteWise.ListAssetProperties",
);
