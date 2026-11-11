import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxDataview } from "./GetKxDataview.ts";

export const GetKxDataviewHttp = Layer.effect(
  GetKxDataview,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxDataview",
    operation: finspace.getKxDataview,
    actions: ["finspace:GetKxDataview"],
  }),
);
