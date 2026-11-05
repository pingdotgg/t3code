import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { DescribeProvisioningParameters } from "./DescribeProvisioningParameters.ts";

export const DescribeProvisioningParametersHttp = Layer.effect(
  DescribeProvisioningParameters,
  makeServiceCatalogHttpBinding({
    capability: "DescribeProvisioningParameters",
    iamActions: ["servicecatalog:DescribeProvisioningParameters"],
    operation: servicecatalog.describeProvisioningParameters,
  }),
);
