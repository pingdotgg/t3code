import * as pricing from "@distilled.cloud/aws/pricing";
import * as Layer from "effect/Layer";
import { makePricingHttpBinding } from "./BindingHttp.ts";
import { GetPriceListFileUrl } from "./GetPriceListFileUrl.ts";

export const GetPriceListFileUrlHttp = Layer.effect(
  GetPriceListFileUrl,
  makePricingHttpBinding({
    capability: "GetPriceListFileUrl",
    iamActions: ["pricing:GetPriceListFileUrl"],
    operation: pricing.getPriceListFileUrl,
  }),
);
