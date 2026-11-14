import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxChangeset } from "./GetKxChangeset.ts";

export const GetKxChangesetHttp = Layer.effect(
  GetKxChangeset,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxChangeset",
    operation: finspace.getKxChangeset,
    actions: ["finspace:GetKxChangeset"],
  }),
);
