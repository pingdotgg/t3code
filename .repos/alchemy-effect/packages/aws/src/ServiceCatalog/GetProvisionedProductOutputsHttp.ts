import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { GetProvisionedProductOutputs } from "./GetProvisionedProductOutputs.ts";

export const GetProvisionedProductOutputsHttp = Layer.effect(
  GetProvisionedProductOutputs,
  makeServiceCatalogHttpBinding({
    capability: "GetProvisionedProductOutputs",
    iamActions: ["servicecatalog:GetProvisionedProductOutputs"],
    operation: servicecatalog.getProvisionedProductOutputs,
  }),
);
