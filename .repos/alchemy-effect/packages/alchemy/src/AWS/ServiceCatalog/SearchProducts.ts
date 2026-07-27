import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:SearchProducts`.
 *
 * Searches the products to which the caller has access — the end-user view of the catalog (products published to a portfolio the caller's principal is associated with).
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.SearchProductsHttp)`.
 * @binding
 * @section Browsing the Catalog
 * @example List the Products the Caller Can Launch
 * ```typescript
 * // init — account-level binding, no resource argument
 * const searchProducts = yield* AWS.ServiceCatalog.SearchProducts();
 *
 * // runtime
 * const { ProductViewSummaries } = yield* searchProducts();
 * ```
 */
export interface SearchProducts extends Binding.Service<
  SearchProducts,
  "AWS.ServiceCatalog.SearchProducts",
  () => Effect.Effect<
    (
      request?: servicecatalog.SearchProductsInput,
    ) => Effect.Effect<
      servicecatalog.SearchProductsOutput,
      servicecatalog.SearchProductsError
    >
  >
> {}
export const SearchProducts = Binding.Service<SearchProducts>(
  "AWS.ServiceCatalog.SearchProducts",
);
