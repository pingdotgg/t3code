import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListPrincipals } from "./ListPrincipals.ts";

export const ListPrincipalsHttp = Layer.effect(
  ListPrincipals,
  makeRAMHttpBinding({
    capability: "ListPrincipals",
    iamActions: ["ram:ListPrincipals"],
    operation: ram.listPrincipals,
  }),
);
