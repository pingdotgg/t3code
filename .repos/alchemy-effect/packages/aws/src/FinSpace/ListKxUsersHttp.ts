import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { ListKxUsers } from "./ListKxUsers.ts";

export const ListKxUsersHttp = Layer.effect(
  ListKxUsers,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxUsers",
    operation: finspace.listKxUsers,
    actions: ["finspace:ListKxUsers"],
  }),
);
