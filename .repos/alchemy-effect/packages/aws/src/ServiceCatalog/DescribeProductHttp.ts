import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { DescribeProduct } from "./DescribeProduct.ts";

export const DescribeProductHttp = Layer.effect(
  DescribeProduct,
  makeServiceCatalogHttpBinding({
    capability: "DescribeProduct",
    iamActions: ["servicecatalog:DescribeProduct"],
    operation: servicecatalog.describeProduct,
  }),
);
