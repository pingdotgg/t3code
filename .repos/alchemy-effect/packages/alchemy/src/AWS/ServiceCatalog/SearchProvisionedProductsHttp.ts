import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { SearchProvisionedProducts } from "./SearchProvisionedProducts.ts";

export const SearchProvisionedProductsHttp = Layer.effect(
  SearchProvisionedProducts,
  makeServiceCatalogHttpBinding({
    capability: "SearchProvisionedProducts",
    iamActions: ["servicecatalog:SearchProvisionedProducts"],
    operation: servicecatalog.searchProvisionedProducts,
  }),
);
