import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:SearchProvisionedProducts`.
 *
 * Searches the provisioned products the caller has access to, with optional free-text filters and account-level access filters.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.SearchProvisionedProductsHttp)`.
 * @binding
 * @section Tracking Provisioned Products
 * @example List the Caller's Provisioned Products
 * ```typescript
 * // init — account-level binding, no resource argument
 * const searchProvisionedProducts = yield* AWS.ServiceCatalog.SearchProvisionedProducts();
 *
 * // runtime
 * const { ProvisionedProducts } = yield* searchProvisionedProducts();
 * ```
 */
export interface SearchProvisionedProducts extends Binding.Service<
  SearchProvisionedProducts,
  "AWS.ServiceCatalog.SearchProvisionedProducts",
  () => Effect.Effect<
    (
      request?: servicecatalog.SearchProvisionedProductsInput,
    ) => Effect.Effect<
      servicecatalog.SearchProvisionedProductsOutput,
      servicecatalog.SearchProvisionedProductsError
    >
  >
> {}
export const SearchProvisionedProducts =
  Binding.Service<SearchProvisionedProducts>(
    "AWS.ServiceCatalog.SearchProvisionedProducts",
  );
