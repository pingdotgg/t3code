import * as pricing from "@distilled.cloud/aws/pricing";
import * as Layer from "effect/Layer";
import { makePricingHttpBinding } from "./BindingHttp.ts";
import { ListPriceLists } from "./ListPriceLists.ts";

export const ListPriceListsHttp = Layer.effect(
  ListPriceLists,
  makePricingHttpBinding({
    capability: "ListPriceLists",
    iamActions: ["pricing:ListPriceLists"],
    operation: pricing.listPriceLists,
  }),
);
