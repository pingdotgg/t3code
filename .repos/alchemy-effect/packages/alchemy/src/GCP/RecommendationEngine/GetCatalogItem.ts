import type * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CatalogsCatalogItem } from "./CatalogsCatalogItem.ts";

export interface GetCatalogItemRequest extends Omit<
  recommendationengine.GetProjectsLocationsCatalogsCatalogItemsRequest,
  "name"
> {}

/**
 * Runtime binding for Recommendations AI `catalogItems.get`.
 *
 * Bind this operation to a {@link CatalogsCatalogItem} in a Function
 * or Action init phase. Provide {@link GetCatalogItemHttp}.
 *
 * Grants `roles/automlrecommendations.viewer` on the project:
 * Recommendations AI has no resource-level IAM.
 *
 * ### Reading Catalog Items
 * **Example:** Read the bound catalog item
 * ```typescript
 * const getCatalogItem = yield* GCP.RecommendationEngine.GetCatalogItem(item);
 * const live = yield* getCatalogItem();
 * ```
 *
 * @binding
 * @category RecommendationEngine
 */
export interface GetCatalogItem extends Binding.Service<
  GetCatalogItem,
  "GCP.RecommendationEngine.GetCatalogItem",
  (
    item: CatalogsCatalogItem,
  ) => Effect.Effect<
    (
      request?: GetCatalogItemRequest,
    ) => Effect.Effect<
      recommendationengine.GoogleCloudRecommendationengineV1beta1CatalogItem,
      recommendationengine.GetProjectsLocationsCatalogsCatalogItemsError,
      RuntimeContext
    >
  >
> {}

export const GetCatalogItem = Binding.Service<GetCatalogItem>(
  "GCP.RecommendationEngine.GetCatalogItem",
);
