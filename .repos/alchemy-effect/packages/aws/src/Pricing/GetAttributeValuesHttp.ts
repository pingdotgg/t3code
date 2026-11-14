import * as pricing from "@distilled.cloud/aws/pricing";
import * as Layer from "effect/Layer";
import { makePricingHttpBinding } from "./BindingHttp.ts";
import { GetAttributeValues } from "./GetAttributeValues.ts";

export const GetAttributeValuesHttp = Layer.effect(
  GetAttributeValues,
  makePricingHttpBinding({
    capability: "GetAttributeValues",
    iamActions: ["pricing:GetAttributeValues"],
    operation: pricing.getAttributeValues,
  }),
);
