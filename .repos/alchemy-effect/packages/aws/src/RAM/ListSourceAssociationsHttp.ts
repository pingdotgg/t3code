import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListSourceAssociations } from "./ListSourceAssociations.ts";

export const ListSourceAssociationsHttp = Layer.effect(
  ListSourceAssociations,
  makeRAMHttpBinding({
    capability: "ListSourceAssociations",
    iamActions: ["ram:ListSourceAssociations"],
    operation: ram.listSourceAssociations,
  }),
);
