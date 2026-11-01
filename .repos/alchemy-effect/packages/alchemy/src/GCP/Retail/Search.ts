import type * as retail from "@distilled.cloud/gcp/retail_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CatalogsServingConfig } from "./CatalogsServingConfig.ts";

export interface SearchRequest extends Omit<
  retail.SearchProjectsLocationsCatalogsServingConfigsRequest,
  "placement"
> {}

/**
 * Runtime binding for Retail `servingConfigs.search`.
 *
 * Bind this operation to a {@link CatalogsServingConfig} in a Function
 * or Action init phase. Provide {@link SearchHttp}.
 *
 * ### Searching a Catalog
 * **Example:** Search products
 * ```typescript
 * const search = yield* GCP.Retail.Search(serving);
 * const page = yield* search({
 *   body: { visitorId: "visitor-1", query: "shirt", pageSize: 10 },
 * });
 * ```
 *
 * @binding
 * @category Retail
 */
export interface Search extends Binding.Service<
  Search,
  "GCP.Retail.Search",
  (
    servingConfig: CatalogsServingConfig,
  ) => Effect.Effect<
    (
      request: SearchRequest,
    ) => Effect.Effect<
      retail.GoogleCloudRetailV2SearchResponse,
      retail.SearchProjectsLocationsCatalogsServingConfigsError,
      RuntimeContext
    >
  >
> {}

export const Search = Binding.Service<Search>("GCP.Retail.Search");
