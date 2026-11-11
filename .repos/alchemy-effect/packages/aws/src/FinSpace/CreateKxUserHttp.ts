import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { CreateKxUser } from "./CreateKxUser.ts";

export const CreateKxUserHttp = Layer.effect(
  CreateKxUser,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.CreateKxUser",
    operation: finspace.createKxUser,
    actions: ["finspace:CreateKxUser"],
  }),
);
