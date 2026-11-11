import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { SearchProducts } from "./SearchProducts.ts";

export const SearchProductsHttp = Layer.effect(
  SearchProducts,
  makeServiceCatalogHttpBinding({
    capability: "SearchProducts",
    iamActions: ["servicecatalog:SearchProducts"],
    operation: servicecatalog.searchProducts,
  }),
);
