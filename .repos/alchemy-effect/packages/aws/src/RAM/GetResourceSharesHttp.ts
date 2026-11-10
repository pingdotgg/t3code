import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { GetResourceShares } from "./GetResourceShares.ts";

export const GetResourceSharesHttp = Layer.effect(
  GetResourceShares,
  makeRAMHttpBinding({
    capability: "GetResourceShares",
    iamActions: ["ram:GetResourceShares"],
    operation: ram.getResourceShares,
  }),
);
