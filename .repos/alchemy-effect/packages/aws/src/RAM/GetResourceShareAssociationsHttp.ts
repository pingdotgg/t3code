import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { GetResourceShareAssociations } from "./GetResourceShareAssociations.ts";

export const GetResourceShareAssociationsHttp = Layer.effect(
  GetResourceShareAssociations,
  makeRAMHttpBinding({
    capability: "GetResourceShareAssociations",
    iamActions: ["ram:GetResourceShareAssociations"],
    operation: ram.getResourceShareAssociations,
  }),
);
