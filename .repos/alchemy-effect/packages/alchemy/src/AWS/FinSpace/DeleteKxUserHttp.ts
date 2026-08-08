import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { DeleteKxUser } from "./DeleteKxUser.ts";

export const DeleteKxUserHttp = Layer.effect(
  DeleteKxUser,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.DeleteKxUser",
    operation: finspace.deleteKxUser,
    actions: ["finspace:DeleteKxUser"],
  }),
);
