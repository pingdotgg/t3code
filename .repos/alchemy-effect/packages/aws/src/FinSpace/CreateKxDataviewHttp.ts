import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { CreateKxDataview } from "./CreateKxDataview.ts";

export const CreateKxDataviewHttp = Layer.effect(
  CreateKxDataview,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.CreateKxDataview",
    operation: finspace.createKxDataview,
    actions: ["finspace:CreateKxDataview"],
  }),
);
