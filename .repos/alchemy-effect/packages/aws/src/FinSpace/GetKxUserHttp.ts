import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxUser } from "./GetKxUser.ts";

export const GetKxUserHttp = Layer.effect(
  GetKxUser,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxUser",
    operation: finspace.getKxUser,
    actions: ["finspace:GetKxUser"],
  }),
);
