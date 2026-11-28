import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { CreateKxChangeset } from "./CreateKxChangeset.ts";

export const CreateKxChangesetHttp = Layer.effect(
  CreateKxChangeset,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.CreateKxChangeset",
    operation: finspace.createKxChangeset,
    actions: ["finspace:CreateKxChangeset"],
  }),
);
