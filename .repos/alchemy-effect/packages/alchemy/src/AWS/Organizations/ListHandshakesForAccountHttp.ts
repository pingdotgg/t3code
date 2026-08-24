import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListHandshakesForAccount } from "./ListHandshakesForAccount.ts";

export const ListHandshakesForAccountHttp = Layer.effect(
  ListHandshakesForAccount,
  makeOrganizationsHttpBinding({
    capability: "ListHandshakesForAccount",
    iamActions: ["organizations:ListHandshakesForAccount"],
    operation: organizations.listHandshakesForAccount,
  }),
);
