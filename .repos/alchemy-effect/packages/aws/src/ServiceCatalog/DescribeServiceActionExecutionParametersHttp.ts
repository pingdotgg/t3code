import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Layer from "effect/Layer";
import { makeServiceCatalogHttpBinding } from "./BindingHttp.ts";
import { DescribeServiceActionExecutionParameters } from "./DescribeServiceActionExecutionParameters.ts";

export const DescribeServiceActionExecutionParametersHttp = Layer.effect(
  DescribeServiceActionExecutionParameters,
  makeServiceCatalogHttpBinding({
    capability: "DescribeServiceActionExecutionParameters",
    iamActions: ["servicecatalog:DescribeServiceActionExecutionParameters"],
    operation: servicecatalog.describeServiceActionExecutionParameters,
  }),
);
