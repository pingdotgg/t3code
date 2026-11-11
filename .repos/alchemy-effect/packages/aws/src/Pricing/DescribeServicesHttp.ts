import * as pricing from "@distilled.cloud/aws/pricing";
import * as Layer from "effect/Layer";
import { makePricingHttpBinding } from "./BindingHttp.ts";
import { DescribeServices } from "./DescribeServices.ts";

export const DescribeServicesHttp = Layer.effect(
  DescribeServices,
  makePricingHttpBinding({
    capability: "DescribeServices",
    iamActions: ["pricing:DescribeServices"],
    operation: pricing.describeServices,
  }),
);
