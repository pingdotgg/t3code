import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { ListStackInstancesForProvisionedProduct } from "./ListStackInstancesForProvisionedProduct.ts";

export const ListStackInstancesForProvisionedProductHttp = Layer.effect(
  ListStackInstancesForProvisionedProduct,
  makeServiceCatalogHttpBinding({
    capability: "ListStackInstancesForProvisionedProduct",
    iamActions: ["servicecatalog:ListStackInstancesForProvisionedProduct"],
    operation: servicecatalog.listStackInstancesForProvisionedProduct,
  }),
);
