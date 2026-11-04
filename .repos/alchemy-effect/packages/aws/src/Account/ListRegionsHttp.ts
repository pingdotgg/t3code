import * as account from "@distilled.cloud/aws/account";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { ListRegions } from "./ListRegions.ts";

export const ListRegionsHttp = Layer.effect(
  ListRegions,
  makeAccountHttpBinding({
    capability: "ListRegions",
    iamActions: ["account:ListRegions"],
    operation: account.listRegions,
  }),
);
